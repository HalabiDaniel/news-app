/**
 * Reading configuration out of the environment, defensively.
 *
 * Two hosts feed this app and both can hand us a variable that is *present but
 * empty*: GitHub Actions turns an unset `${{ vars.FOO }}` into an empty string
 * rather than omitting the key, and Vercel lets you save a blank value. A bare
 * `process.env.FOO ?? default` then keeps the empty string, and — worse for the
 * numeric knobs — `Number('')` is `0`, which is a perfectly finite number. That
 * is how `OPENAI_KNOWN_VOCAB_LIMIT` could silently become "send everything".
 *
 * So: blank means unset, everywhere.
 */

/** A trimmed string, or `undefined` when the variable is missing or blank. */
export function envString(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * A finite number, or `fallback` when the variable is missing, blank or not a
 * number. Unlike `Number(x) || fallback` this keeps an explicit `0`, which
 * several knobs use to mean "no limit".
 */
export function envNumber(name: string, fallback: number): number {
  const raw = envString(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[env] ${name}="${raw}" is not a number — using ${fallback}.`);
    return fallback;
  }
  return n;
}

/** As `envNumber`, clamped to at least `min`. */
export function envNumberMin(name: string, fallback: number, min: number): number {
  return Math.max(min, envNumber(name, fallback));
}

/**
 * As `envNumber`, but a zero or negative value falls back too. For a timeout or
 * a token cap "0" is never a meaningful setting, only a typo waiting to abort
 * every call.
 */
export function envPositive(name: string, fallback: number): number {
  const n = envNumber(name, fallback);
  if (n <= 0) {
    console.warn(`[env] ${name}=${n} must be greater than zero — using ${fallback}.`);
    return fallback;
  }
  return n;
}

/** A trimmed, lower-cased string, or `fallback`. */
export function envEnum(name: string, fallback: string): string {
  return (envString(name) ?? fallback).toLowerCase();
}
