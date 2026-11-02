import { describe, expect, it } from "vitest";
import { firstWorkingAddress, pairingCodeText, parsePairingCode, SyncKeyRejected } from "../src/core/sync/pairing.ts";

describe("pairing code", () => {
  it("round-trips the addresses and key", () => {
    const details = { addresses: ["http://192.168.1.20:5180", "http://10.0.0.5:5180"], syncKey: "key" };
    expect(parsePairingCode(pairingCodeText(details))).toEqual(details);
  });

  it("refuses other QR codes", () => {
    for (const text of ["https://example.com", "null", "{}", '{"format":"other","addresses":["a"],"syncKey":"k"}',
      JSON.stringify({ format: "lifeboard-pairing-1", addresses: "a", syncKey: "k" }),
      JSON.stringify({ format: "lifeboard-pairing-1", addresses: ["a"] })]) {
      expect(() => parsePairingCode(text)).toThrow(/isn't a Lifeboard pairing code/);
    }
  });

  it("explains a desktop with no network", () => {
    expect(() => parsePairingCode(pairingCodeText({ addresses: [], syncKey: "k" }))).toThrow(/no network connection/);
  });
});

describe("firstWorkingAddress", () => {
  it("moves past addresses that can't be reached", async () => {
    const tried: string[] = [];
    const found = await firstWorkingAddress(["a", "b", "c"], async (address) => {
      tried.push(address);
      if (address !== "b") throw new Error(`no ${address}`);
    });
    expect(found).toBe("b");
    expect(tried).toEqual(["a", "b"]);
  });

  it("reports the first failure when none work", async () => {
    await expect(firstWorkingAddress(["a", "b"], async (address) => { throw new Error(`no ${address}`); })).rejects.toThrow("no a");
  });

  it("stops at a refused key", async () => {
    const tried: string[] = [];
    await expect(firstWorkingAddress(["a", "b"], async (address) => {
      tried.push(address);
      throw new SyncKeyRejected("refused");
    })).rejects.toThrow("refused");
    expect(tried).toEqual(["a"]);
  });
});
