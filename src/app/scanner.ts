// Scanning a QR code with Google's code scanner (Play services). It shows its own camera screen
// and hands back only the result, so Lifeboard needs no camera permission.
import {
  BarcodeFormat, BarcodeScanner, GoogleBarcodeScannerModuleInstallState as InstallState,
} from "@capacitor-mlkit/barcode-scanning";

/** A slow network shouldn't leave the button waiting forever. */
const INSTALL_TIMEOUT_MS = 60_000;
/** The plugin's error when the user backs out of the camera screen (ERROR_SCAN_CANCELED). */
const SCAN_CANCELED = "scan canceled.";

/** The QR code's text, or null if the user backed out. */
export async function scanQrCode(): Promise<string | null> {
  await ensureScannerInstalled();
  try {
    const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
    return barcodes[0]?.rawValue ?? null;
  } catch (error) {
    if ((error as Error).message === SCAN_CANCELED) return null;
    throw error;
  }
}

/** Play services fetches the scanner on first use; a sideloaded app can't have it pre-installed. */
async function ensureScannerInstalled(): Promise<void> {
  const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
  if (available) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const handles: { remove(): Promise<void> }[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Couldn't download the scanner in time. Check the connection, or enter the address and sync key below.")), INSTALL_TIMEOUT_MS);
      BarcodeScanner.addListener("googleBarcodeScannerModuleInstallProgress", ({ state }) => {
        if (state === InstallState.COMPLETED) resolve();
        if (state === InstallState.FAILED || state === InstallState.CANCELED) reject(new Error("Couldn't download the scanner. Enter the address and sync key below instead."));
      }).then((handle) => {
        handles.push(handle);
        return BarcodeScanner.installGoogleBarcodeScannerModule();
      }).catch(reject);
    });
  } finally {
    clearTimeout(timer);
    await Promise.all(handles.map((handle) => handle.remove()));
  }
}
