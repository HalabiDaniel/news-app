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

// Parse a YYYY-MM-DD string to a UTC Date, or null if it isn't one.
// Everything below formats *dates*, never instants, so UTC throughout keeps a
// day from sliding either side of midnight depending on where it is rendered.
function parseISODate(dateStr: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

// "Mo., 13. Sep." — for lists, where the full form is too long to scan.
export function formatShortDate(dateStr: string): string {
  const date = parseISODate(dateStr);
  if (!date) return dateStr;
  return new Intl.DateTimeFormat('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
}

// "September 2026" — the archive index groups by month under this heading.
export function formatMonthLabel(dateStr: string): string {
  const date = parseISODate(dateStr);
  if (!date) return dateStr;
  return new Intl.DateTimeFormat('de-DE', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** The YYYY-MM key a date groups under. */
export function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7);
}

/** Whole days from `from` to `to`, both YYYY-MM-DD. Negative if `to` is earlier. */
export function daysBetween(from: string, to: string): number | null {
  const a = parseISODate(from);
  const b = parseISODate(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

// "heute" / "gestern" / "vor 3 Tagen". Used by the empty state, where the
// interesting number is the *gap*, not the date: three days is an outage, one
// day is a late run.
export function relativeDaysDe(dateStr: string, today: string = berlinDateString()): string {
  const diff = daysBetween(dateStr, today);
  if (diff === null) return dateStr;
  if (diff <= 0) return 'heute';
  if (diff === 1) return 'gestern';
  return `vor ${diff} Tagen`;
}
