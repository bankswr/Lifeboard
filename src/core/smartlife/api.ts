// Smart Life (Tuya) cloud API, read-only: the QR-code sign-in and device reads that Home
// Assistant's Tuya integration uses. Ported from Tuya's own tuya-device-sharing-sdk 0.2.15
// (MIT; customerapi.py, user.py, home.py, device.py); see
// agent-notes/2026-10-16-smartlife-feeders.md. Lifeboard never sends commands to devices.
//
// Crypto is @noble (pure JS, synchronous) rather than WebCrypto because the signing needs
// MD5, which WebCrypto lacks, and this file runs on the phone as well as in Node.
import { gcm } from "@noble/ciphers/aes.js";
import { bytesToUtf8 } from "@noble/ciphers/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { md5 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

// Home Assistant's public client id and schema for this sign-in (HA tuya/const.py). Tuya
// issued them to Home Assistant; every no-developer-account Smart Life tool reuses them.
const CLIENT_ID = "HA_3y9q4ak7g4ephrvke";
const SCHEMA = "haauthorize";
const LOGIN_HOST = "https://apigw.iotbing.com";
/** Refresh the access token when it has less than this left (the SDK's margin). */
const REFRESH_MARGIN_MS = 60 * 1000;

export interface SmartLifeTokens {
  /** The account's regional API host, from the sign-in. */
  endpoint: string;
  accessToken: string;
  refreshToken: string;
  /** When the access token stops working, ms since 1970. */
  expiresAt: number;
}

/** A device as the cloud describes it; `status` is a list of {code, value}. */
export type RawDevice = Record<string, any>;

/** The account's sign-in no longer works: the user has to scan a new QR code. */
export class SmartLifeSignInError extends Error {}

/** The calls the integration makes; tests swap in a fake. */
export interface SmartLifeApi {
  /** Starts a QR sign-in; returns the token to show as a QR code and to poll with. */
  startQrSignIn(userCode: string): Promise<string>;
  /** The tokens once the QR code has been scanned and confirmed, otherwise null. */
  qrSignInResult(userCode: string, qrToken: string): Promise<SmartLifeTokens | null>;
  /** Fresh tokens; throws SmartLifeSignInError when the refresh token no longer works. */
  refresh(tokens: SmartLifeTokens): Promise<SmartLifeTokens>;
  /** Every device in every home on the account. */
  devices(tokens: SmartLifeTokens): Promise<RawDevice[]>;
}

/** What the QR code must contain for the Smart Life app's scanner. */
export function qrCodeText(qrToken: string): string {
  return `tuyaSmart--qrLogin?token=${qrToken}`;
}

export function needsRefresh(tokens: SmartLifeTokens, now = Date.now()): boolean {
  return tokens.expiresAt - REFRESH_MARGIN_MS <= now;
}

interface ApiResponse {
  success: boolean;
  code?: number;
  msg?: string;
  result?: any;
  /** Server time, ms. */
  t: number;
}

export const tuyaSmartLifeApi: SmartLifeApi = {
  async startQrSignIn(userCode) {
    const response = await getJson(
      `${LOGIN_HOST}/v1.0/m/life/home-assistant/qrcode/tokens?clientid=${CLIENT_ID}&usercode=${encodeURIComponent(userCode)}&schema=${SCHEMA}`,
      { method: "POST" },
    );
    if (!response.success) throw new Error(`Smart Life didn't accept the user code (${response.msg ?? response.code}).`);
    return response.result.qrcode;
  },

  async qrSignInResult(userCode, qrToken) {
    const response = await getJson(
      `${LOGIN_HOST}/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(qrToken)}?clientid=${CLIENT_ID}&usercode=${encodeURIComponent(userCode)}`,
    );
    if (!response.success) return null; // not scanned yet
    const r = response.result;
    return {
      endpoint: r.endpoint,
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: response.t + r.expire_time * 1000,
    };
  },

  async refresh(tokens) {
    let response: ApiResponse;
    try {
      response = await signedGet(tokens, `/v1.0/m/token/${tokens.refreshToken}`);
    } catch (error) {
      if (error instanceof TuyaApiError) throw new SmartLifeSignInError(`Smart Life ended the sign-in (${error.message}).`);
      throw error;
    }
    const r = response.result;
    return { endpoint: tokens.endpoint, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: response.t + r.expireTime * 1000 };
  },

  async devices(tokens) {
    const homes = (await signedGet(tokens, "/v1.0/m/life/users/homes")).result as any[];
    const devices: RawDevice[] = [];
    for (const home of homes) {
      const response = await signedGet(tokens, "/v1.0/m/life/ha/home/devices", { homeId: String(home.ownerId) });
      devices.push(...(response.result as RawDevice[]));
    }
    return devices;
  },
};

/** The service answered but refused the request (as opposed to a network problem). */
class TuyaApiError extends Error {}

async function getJson(url: string, init?: RequestInit): Promise<ApiResponse> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Smart Life: HTTP ${response.status}`);
  return (await response.json()) as ApiResponse;
}

// ---------- signed, encrypted requests (customerapi.py) ----------

/**
 * A GET to the account's API host. Each request derives a one-time key from a random request
 * id and the refresh token; the query and the result are AES-GCM encrypted with it, and the
 * headers are HMAC-signed.
 */
async function signedGet(tokens: SmartLifeTokens, path: string, params?: Record<string, string>): Promise<ApiResponse> {
  const requestId = crypto.randomUUID();
  const hashKey = bytesToHex(md5(utf8ToBytes(requestId + tokens.refreshToken)));
  const secret = requestSecret(requestId, hashKey);

  let encryptedQuery = "";
  let url = tokens.endpoint + path;
  if (params) {
    encryptedQuery = encrypt(JSON.stringify(params), secret);
    url += `?encdata=${encodeURIComponent(encryptedQuery)}`;
  }
  const headers: Record<string, string> = {
    "X-appKey": CLIENT_ID,
    "X-requestId": requestId,
    "X-sid": "",
    "X-time": String(Date.now()),
    "X-token": tokens.accessToken,
  };
  headers["X-sign"] = requestSignature(hashKey, headers, encryptedQuery);

  const response = await getJson(url, { headers });
  if (!response.success) throw new TuyaApiError(`${response.code}: ${response.msg}`);
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

/** The per-request AES key: the first 16 hex characters of HMAC-SHA256(requestId, hashKey). */
export function requestSecret(requestId: string, hashKey: string): string {
  // The SDK mixes in a session id here, but it is always empty for this client.
  return bytesToHex(hmac(sha256, utf8ToBytes(requestId), utf8ToBytes(hashKey))).slice(0, 16);
}

export function requestSignature(hashKey: string, headers: Record<string, string>, encryptedQuery: string): string {
  const signed = ["X-appKey", "X-requestId", "X-sid", "X-time", "X-token"]
    .filter((name) => headers[name])
    .map((name) => `${name}=${headers[name]}`)
    .join("||");
  return bytesToHex(hmac(sha256, utf8ToBytes(hashKey), utf8ToBytes(signed + encryptedQuery)));
}

const NONCE_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";

export function encrypt(plain: string, secret: string): string {
  const randomIndexes = crypto.getRandomValues(new Uint8Array(12));
  const nonce = Array.from(randomIndexes, (n) => NONCE_ALPHABET[n % NONCE_ALPHABET.length]).join("");
  const sealed = gcm(utf8ToBytes(secret), utf8ToBytes(nonce)).encrypt(utf8ToBytes(plain));
  // As the SDK does: nonce and ciphertext are base64-encoded separately, then joined. A
  // 12-byte nonce encodes without padding, so the result is also base64 of nonce + ciphertext.
  return btoa(nonce) + toBase64(sealed);
}

export function decrypt(encoded: string, secret: string): string {
  const data = fromBase64(encoded);
  return bytesToUtf8(gcm(utf8ToBytes(secret), data.subarray(0, 12)).decrypt(data.subarray(12)));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
