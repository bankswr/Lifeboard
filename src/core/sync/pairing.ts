// The QR code that pairs a phone with the desktop: what the desktop's Settings shows and the
// phone scans, instead of typing the address and sync key (docs/PLAN.md phase 2).

export interface PairingDetails {
  /** The desktop can have several network addresses; only some may reach this phone. */
  addresses: string[];
  syncKey: string;
}

/** Marks a code as ours, so scanning some other QR code gets a clear message. */
const FORMAT = "lifeboard-pairing-1";

export function pairingCodeText({ addresses, syncKey }: PairingDetails): string {
  return JSON.stringify({ format: FORMAT, addresses, syncKey });
}

/** Reads a scanned code. Throws with a readable message if it isn't a Lifeboard pairing code. */
export function parsePairingCode(text: string): PairingDetails {
  const notOurs = new Error("That isn't a Lifeboard pairing code. Scan the one in the desktop's Settings.");
  let code: { format?: unknown; addresses?: unknown; syncKey?: unknown };
  try {
    code = JSON.parse(text);
  } catch {
    throw notOurs;
  }
  const { format, addresses, syncKey } = code ?? {};
  if (format !== FORMAT || typeof syncKey !== "string" || !syncKey) throw notOurs;
  if (!Array.isArray(addresses) || !addresses.every((address) => typeof address === "string")) throw notOurs;
  if (addresses.length === 0) throw new Error("The desktop found no network connection. Check it, then scan again.");
  return { addresses, syncKey };
}

/** The desktop answered and refused the key: another address wouldn't change that. */
export class SyncKeyRejected extends Error {}

/**
 * Tries each address in turn and returns the first that `attempt` succeeds with. Throws the
 * first address's error if none do, unless the key was refused, which ends the search at once.
 */
export async function firstWorkingAddress(addresses: string[], attempt: (address: string) => Promise<void>): Promise<string> {
  let firstError: unknown;
  for (const address of addresses) {
    try {
      await attempt(address);
      return address;
    } catch (error) {
      if (error instanceof SyncKeyRejected) throw error;
      firstError ??= error;
    }
  }
  throw firstError;
}
