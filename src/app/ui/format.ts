// Display formatting shared by several screens.

/** A stored UTC time in the device's local format, or null when there is none. */
export function formatTime(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleString() : null;
}
