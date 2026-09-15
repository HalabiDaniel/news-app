import { NextResponse } from 'next/server';

import { checkPassphrase, parseSubscription } from '@/lib/pushSubscription';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Turns the toggle off: the browser drops its subscription, this drops the row.
//
// Deleting by endpoint is safe to do unauthenticated-ish for the same reason the
// whole surface is: the endpoint is the secret. You can only remove a device
// whose endpoint you already hold, and a device can always re-subscribe.
export async function POST(request: Request): Promise<NextResponse> {
  const pass = checkPassphrase(request);
  if (pass !== 'ok') {
    return NextResponse.json({ error: pass }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
    return NextResponse.json({ error: 'Missing or invalid endpoint.' }, { status: 400 });
  }

  const { error } = await getSupabaseAdmin()
    .from('push_subscriptions')
    .delete()
    .eq('endpoint', endpoint);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
