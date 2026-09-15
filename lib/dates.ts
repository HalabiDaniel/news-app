export const BERLIN_TZ = 'Europe/Berlin';

// Returns today's date in Europe/Berlin as an ISO YYYY-MM-DD string.
// `en-CA` formats dates as YYYY-MM-DD, which is exactly what Postgres `date` wants.
export function berlinDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BERLIN_TZ }).format(d);
}

// Current hour (0-23) in Europe/Berlin. Handy if you ever want a time-window gate.
export function berlinHour(d: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: BERLIN_TZ,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const value = parts.find((p) => p.type === 'hour')?.value ?? '0';
  return parseInt(value, 10) % 24;
}

// Human-friendly German rendering of a YYYY-MM-DD string, e.g. "Mittwoch, 15. Juli 2026".
// Falls back to the raw string if the input isn't a valid date.
export function formatDisplayDate(dateStr: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(date.getTime())) return dateStr;
  return new Intl.DateTimeFormat('de-DE', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
