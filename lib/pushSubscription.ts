/**
 * Validating and storing browser push subscriptions.
 *
 * Everything here guards `/api/push/*`, which is publicly reachable on a public
 * site and writes to the database on an unauthenticated POST. Three layers, in
 * order of how much they actually protect:
 *
 *   1. A shared passphrase, if PUSH_PASSPHRASE is set. Typed once per device,
 *      and it closes the endpoint completely. Recommended — there is exactly one
 *      intended user.
 *   2. Strict shape validation, so the table can only ever hold things that
 *      look like push subscriptions.
 *   3. A hard row cap, which turns "unbounded growth" into "contained failure".
 *      Fifty devices is already absurd for a personal app.
 *
 * None of this is authentication in any real sense, and it doesn't need to be:
 * the worst a successful attacker achieves is receiving one German news
 * notification per morning.
 */
import { timingSafeEqual } from 'node:crypto';

import { envNumberMin, envString } from './env';
import { getSupabaseAdmin } from './supabaseAdmin';

/** The subscription as the browser's `PushSubscription.toJSON()` hands it over. */
export interface ClientSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** How many devices may be registered at once. */
const MAX_SUBSCRIPTIONS = envNumberMin('PUSH_MAX_SUBSCRIPTIONS', 50, 1);

/**
 * Is the caller allowed to touch a subscription at all?
 *
 * With no PUSH_PASSPHRASE set the endpoints are open, which is the documented
 * default — the shape checks and the row cap still apply. Returns an error code
 * the client understands rather than a boolean, so the toggle can tell "I need
 * to ask for the passphrase" apart from "that passphrase was wrong".
 */
export function checkPassphrase(request: Request): 'ok' | 'required' | 'wrong' {
  const expected = envString('PUSH_PASSPHRASE');
  if (!expected) return 'ok';

  const given = request.headers.get('x-push-passphrase');
  if (!given) return 'required';

  // Constant-time, and length-safe: timingSafeEqual throws on a length mismatch,
  // which would leak the length through the error path it takes.
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return 'wrong';
  return timingSafeEqual(a, b) ? 'ok' : 'wrong';
}

/**
 * Narrows unknown JSON to a subscription, or returns why it isn't one.
 *
 * The size bounds are deliberately loose — endpoints and keys vary by push
 * service and Apple's are nothing like Google's — but they are bounded, because
 * the point is to keep arbitrary payloads out of the table.
 */
export function parseSubscription(body: unknown): ClientSubscription | string {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object.';
  const { endpoint, keys } = body as Record<string, unknown>;

  if (typeof endpoint !== 'string' || endpoint.length > 1000) return 'Missing or oversized endpoint.';
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return 'Endpoint is not a URL.';
  }
  // https only: a push service endpoint is always https, and anything else here
  // is either a mistake or someone pointing the sender at a host of their choice.
  if (parsed.protocol !== 'https:') return 'Endpoint must be https.';

  if (!keys || typeof keys !== 'object') return 'Missing keys.';
  const { p256dh, auth } = keys as Record<string, unknown>;
  // The real values are a 65-byte point and a 16-byte secret, base64url-encoded
  // (~88 and ~22 characters). The bounds allow for padding variations.
  if (typeof p256dh !== 'string' || p256dh.length < 40 || p256dh.length > 200) return 'Implausible p256dh key.';
  if (typeof auth !== 'string' || auth.length < 12 || auth.length > 100) return 'Implausible auth key.';

  return { endpoint, keys: { p256dh, auth } };
}

/**
 * Stores a subscription, upserting on `endpoint`.
 *
 * Re-subscribing — a reinstall, a permission reset — usually hands back the same
 * endpoint, and inserting instead of upserting would push to that one phone
 * twice every morning.
 */
export async function saveSubscription(
  sub: ClientSubscription,
  userAgent: string | null,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const supabase = getSupabaseAdmin();

  // Only count when this endpoint is new: an existing device must always be
  // able to refresh its keys, even if the table is somehow at the cap.
  const { data: existing } = await supabase
    .from('push_subscriptions')
    .select('endpoint')
    .eq('endpoint', sub.endpoint)
    .maybeSingle();

  if (!existing) {
    const { count } = await supabase
      .from('push_subscriptions')
      .select('endpoint', { count: 'exact', head: true });
    if ((count ?? 0) >= MAX_SUBSCRIPTIONS) {
      return { ok: false, status: 429, error: 'Too many registered devices.' };
    }
  }

  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      user_agent: userAgent?.slice(0, 200) ?? null,
      failure_count: 0,
    },
    { onConflict: 'endpoint' },
  );

  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true };
}
