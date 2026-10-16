// Phase 1 spike (docs/PLAN.md): prove we can sign in to Smart Life and read the feeders'
// status from Node. Read-only: sends no commands and keeps no tokens.
//
//   node spikes/smartlife.ts <user code> [dump.json]
//
// The user code is in the Smart Life app under Me → Settings → Account and Security →
// User Code. The script shows a QR code (in the terminal and as smartlife-qr.svg next to
// the dump); scan it with the Smart Life app's scanner and confirm.
//
// Sign-in and request signing follow Tuya's own tuya-device-sharing-sdk 0.2.15 (MIT,
// `customerapi.py`, `user.py`, `device.py`), the library Home Assistant's Tuya integration
// uses. Throwaway code: the real integration will live in src/core once the spike passes.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import QRCode from "qrcode";

// Home Assistant's public client id and schema for this sign-in (HA `tuya/const.py`).
const CLIENT_ID = "HA_3y9q4ak7g4ephrvke";
const SCHEMA = "haauthorize";
const LOGIN_HOST = "https://apigw.iotbing.com";
const POLL_INTERVAL_MS = 2000;
const POLL_LIMIT_MS = 3 * 60 * 1000;

type Session = { endpoint: string; accessToken: string; refreshToken: string };
type ApiResponse = { success: boolean; code?: number; msg?: string; result?: any; t?: number };

async function startQrLogin(userCode: string): Promise<string> {
  const url = `${LOGIN_HOST}/v1.0/m/life/home-assistant/qrcode/tokens?clientid=${CLIENT_ID}&usercode=${encodeURIComponent(userCode)}&schema=${SCHEMA}`;
  const response = (await (await fetch(url, { method: "POST" })).json()) as ApiResponse;
  if (!response.success) throw new Error(`QR request failed: ${response.code} ${response.msg}`);
  return response.result.qrcode;
}

async function waitForScan(qrToken: string, userCode: string): Promise<Session> {
  const url = `${LOGIN_HOST}/v1.0/m/life/home-assistant/qrcode/tokens/${qrToken}?clientid=${CLIENT_ID}&usercode=${encodeURIComponent(userCode)}`;
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < deadline) {
    const response = (await (await fetch(url)).json()) as ApiResponse;
    if (response.success) {
      const r = response.result;
      console.log(`Signed in. Result fields: ${Object.keys(r).join(", ")}; token expires in ${r.expire_time}s`);
      return { endpoint: r.endpoint, accessToken: r.access_token, refreshToken: r.refresh_token };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error("QR code was not scanned in time");
}

// --- Request signing and encryption (ported from customerapi.py) ---

function randomNonce(length: number): string {
  const alphabet = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
  let nonce = "";
  for (let i = 0; i < length; i++) nonce += alphabet[randomInt(alphabet.length)];
  return nonce;
}

function encrypt(plain: string, secret: string): string {
  const nonce = randomNonce(12);
  const cipher = createCipheriv("aes-128-gcm", Buffer.from(secret), Buffer.from(nonce));
  const sealed = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  // The SDK base64-encodes nonce and ciphertext separately and concatenates the strings.
  return Buffer.from(nonce).toString("base64") + sealed.toString("base64");
}

function decrypt(encoded: string, secret: string): string {
  const data = Buffer.from(encoded, "base64");
  const nonce = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", Buffer.from(secret), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8");
}

async function apiGet(session: Session, path: string, params?: Record<string, string>): Promise<ApiResponse> {
  const requestId = randomUUID();
  const hashKey = createHash("md5").update(requestId + session.refreshToken).digest("hex");
  // sid is always empty for this client, so the secret is just HMAC(requestId, hashKey).
  const secret = createHmac("sha256", requestId).update(hashKey).digest("hex").slice(0, 16);

  let queryEncrypted = "";
  let url = session.endpoint + path;
  if (params && Object.keys(params).length > 0) {
    queryEncrypted = encrypt(JSON.stringify(params), secret);
    url += `?encdata=${encodeURIComponent(queryEncrypted)}`;
  }
  const headers: Record<string, string> = {
    "X-appKey": CLIENT_ID,
    "X-requestId": requestId,
    "X-sid": "",
    "X-time": String(Date.now()),
    "X-token": session.accessToken,
  };
  const signed = ["X-appKey", "X-requestId", "X-sid", "X-time", "X-token"]
    .filter((name) => headers[name] !== "")
    .map((name) => `${name}=${headers[name]}`)
    .join("||");
  headers["X-sign"] = createHmac("sha256", hashKey).update(signed + queryEncrypted).digest("hex");

  const httpResponse = await fetch(url, { headers });
  if (!httpResponse.ok) throw new Error(`${path}: HTTP ${httpResponse.status}`);
  const response = (await httpResponse.json()) as ApiResponse;
  if (!response.success) throw new Error(`${path}: ${response.code} ${response.msg}`);
  if (response.result) {
    const plain = decrypt(response.result, secret);
    try {
      response.result = JSON.parse(plain);
    } catch {
      response.result = plain;
    }
  }
  return response;
}

async function main() {
  const userCode = process.argv[2];
  const dumpPath = process.argv[3] ?? "smartlife-dump.json";
  if (!userCode) throw new Error("usage: node spikes/smartlife.ts <user code> [dump.json]");

  const qrToken = await startQrLogin(userCode);
  const qrText = `tuyaSmart--qrLogin?token=${qrToken}`;
  const svgPath = join(dirname(dumpPath), "smartlife-qr.svg");
  writeFileSync(svgPath, await QRCode.toString(qrText, { type: "svg", margin: 4, width: 400 }));
  console.log(await QRCode.toString(qrText, { type: "terminal", small: true }));
  console.log(`QR code also saved to ${svgPath}. Scan it with the Smart Life app.`);

  const session = await waitForScan(qrToken, userCode);
  const homes = (await apiGet(session, "/v1.0/m/life/users/homes")).result as any[];
  const dump: any[] = [];
  for (const home of homes) {
    const devices = (await apiGet(session, "/v1.0/m/life/ha/home/devices", { homeId: String(home.ownerId) })).result as any[];
    for (const device of devices) {
      const specification = await apiGet(session, `/v1.1/m/life/${device.id}/specifications`).catch((e) => String(e));
      const { local_key, ...rest } = device;
      // The local key is a secret; record only that it exists.
      dump.push({ home: home.name, ...rest, has_local_key: Boolean(local_key), specification });
      console.log(`${home.name} / ${device.name} [${device.category}, ${device.product_name}, product ${device.product_id}] online=${device.online}`);
      for (const s of device.status ?? []) console.log(`    ${s.code} = ${JSON.stringify(s.value)}`);
    }
  }
  writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
  console.log(`Full device details written to ${dumpPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
