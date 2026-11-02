// Calendar dates as "YYYY-MM-DD" strings in this device's local time zone.

export function localDate(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** When a local calendar day begins, as a UTC time ("2026-11-02" in Chicago → "2026-11-02T06:00:00Z"). */
export function localDayStartUtc(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day).toISOString().replace(".000Z", "Z");
}

/** "2026-10-01" + 3 → "2026-10-04". Works on the date alone, so time zones can't shift it. */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
