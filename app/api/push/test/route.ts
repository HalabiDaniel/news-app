import { NextResponse } from 'next/server';

import { formatDisplayDate, berlinDateString } from '@/lib/dates';
import { sendToSubscription } from '@/lib/push';
import { checkPassphrase, parseSubscription } from '@/lib/pushSubscription';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sends one notification to the calling device, immediately.
//
// This is not a development convenience — it is the permanent answer to "did I
// stop getting these because the briefing broke, or because my subscription
// quietly died?". iOS gives no event when a subscription expires; the server
// only finds out by being told 404/410 on a send, and this is how you provoke
// that on demand instead of waiting until tomorrow morning.
//
// NOTE: this is the one route that sends push, so VAPID_PRIVATE_KEY must exist
// in the Vercel environment as well as in Actions. If you would rather keep the
// private key out of Vercel entirely, this endpoint is the thing you lose.
export async function POST(request: Request): Promise<NextResponse> {
  const pass = checkPassphrase(request);
  if (pass !== 'ok') {
    return NextResponse.json({ error: pass }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const sub = parseSubscription(body);
  if (typeof sub === 'string') {
    return NextResponse.json({ error: sub }, { status: 400 });
  }

  const result = await sendToSubscription(sub.endpoint, sub.keys, {
    title: 'Test — alles funktioniert',
    body: `Benachrichtigungen sind aktiv. ${formatDisplayDate(berlinDateString())}`,
    url: '/',
    // Its own tag, so a test never replaces (or is replaced by) the real
    // morning notification sitting on the lock screen.
    tag: 'push-test',
  });

  if (!result.ok) {
    // 410 is the interesting one: the subscription is gone and has just been
    // deleted, so the client should offer to subscribe again rather than retry.
    return NextResponse.json(
      { error: result.message, expired: result.expired },
      { status: result.expired ? 410 : 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
