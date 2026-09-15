/**
 * Web push — the notification that replaced the email.
 *
 * Called from the daily run *after* the articles are persisted and the site
 * cache has been revalidated. Order matters: notifying first means tapping the
 * notification lands on a page that hasn't updated yet, which is the exact
 * failure the revalidate ping exists to prevent.
 *
 * Nothing in here may throw. A briefing that is written and on the website is a
 * successful briefing; a notification problem is a separate, lesser failure and
 * must never mark the day failed.
 */
import webpush from 'web-push';

import { formatDisplayDate } from './dates';
import { envString } from './env';
import { getSupabaseAdmin } from './supabaseAdmin';

interface SubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Points web-push at the VAPID pair, once per process.
 *
 * @returns false when the keys are missing, which is a "skip notifications"
 * condition and never an error: the briefing itself does not depend on them, and
 * a local run has no reason to hold the private key.
 */
export function configureWebPush(): boolean {
  const publicKey = envString('VAPID_PUBLIC_KEY') ?? envString('NEXT_PUBLIC_VAPID_PUBLIC_KEY');
  const privateKey = envString('VAPID_PRIVATE_KEY');
  if (!publicKey || !privateKey) {
    console.warn('[push] VAPID keys not set — skipping notifications.');
    return false;
  }

  // `VAPID_SUBJECT` is required by the spec and must be a mailto: or https URL.
  // envString rather than `??` because Actions hands over blank strings, and a
  // blank subject makes setVapidDetails throw rather than fall back.
  webpush.setVapidDetails(
    envString('VAPID_SUBJECT') ?? 'mailto:info@danielhalabi.com',
    publicKey,
    privateKey,
  );
  return true;
}

/**
 * Pushes one payload to one subscription. Used by the settings page's test
 * button — the control that answers "is this subscription still alive?" in two
 * seconds instead of overnight.
 *
 * Deleting on 404/410 here matters as much as it does in the daily run: a dead
 * subscription found by the test button should disappear on the spot, so the
 * toggle can offer to re-subscribe rather than keep reporting a phantom device.
 */
export async function sendToSubscription(
  endpoint: string,
  keys: { p256dh: string; auth: string },
  payload: { title: string; body: string; url?: string; tag?: string },
): Promise<{ ok: true } | { ok: false; status?: number; expired: boolean; message: string }> {
  if (!configureWebPush()) {
    return { ok: false, expired: false, message: 'VAPID keys are not configured on this deployment.' };
  }

  try {
    await webpush.sendNotification({ endpoint, keys }, JSON.stringify(payload));
    await getSupabaseAdmin()
      .from('push_subscriptions')
      .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
      .eq('endpoint', endpoint);
    return { ok: true };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    const expired = status === 404 || status === 410;
    if (expired) {
      await getSupabaseAdmin().from('push_subscriptions').delete().eq('endpoint', endpoint);
    }
    return {
      ok: false,
      status,
      expired,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pushes one notification to every stored subscription.
 *
 * @returns how many devices accepted the push. This number is written to
 * `briefing_runs.push_sent`, and it is the first thing worth looking at when no
 * notification arrives: `0` means there were no live subscriptions, `1` means it
 * was sent and lost somewhere downstream.
 */
export async function sendBriefingPush(date: string, count: number): Promise<number> {
  if (!configureWebPush()) return 0;

  const supabase = getSupabaseAdmin();
  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth');

  if (error) {
    console.warn(`[push] could not read subscriptions: ${error.message}`);
    return 0;
  }
  if (!subs?.length) {
    console.warn('[push] no subscriptions stored — nobody to notify.');
    return 0;
  }

  const payload = JSON.stringify({
    title: 'Dein Briefing ist da',
    body: `${count} neue Artikel – ${formatDisplayDate(date)}`,
    url: '/',
  });

  let sent = 0;
  for (const s of subs as SubscriptionRow[]) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
      );
      sent++;
      await supabase
        .from('push_subscriptions')
        .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
        .eq('endpoint', s.endpoint);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        // Gone for good. This is the only signal a subscription is dead — there
        // is no event — so deleting here is the only thing that ever cleans the
        // table up. Without it, dead endpoints fail every morning forever.
        await supabase.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
        console.warn(`[push] dropped expired subscription (${status}).`);
      } else {
        // The builder is a thenable, not a promise, so it has no .catch — and a
        // bookkeeping failure must not mask the send failure we are handling.
        try {
          await supabase.rpc('increment_push_failure', { ep: s.endpoint });
        } catch {
          /* ignore */
        }
        console.warn(`[push] send failed (${status ?? 'unknown'}).`);
      }
    }
  }

  return sent;
}

/** Records the delivered count on the run row. Best-effort: never throws. */
export async function recordPushCount(date: string, sent: number): Promise<void> {
  try {
    await getSupabaseAdmin()
      .from('briefing_runs')
      .update({ push_sent: sent })
      .eq('briefing_date', date);
  } catch (err) {
    console.warn(`[push] could not record push_sent: ${err instanceof Error ? err.message : String(err)}`);
  }
}
