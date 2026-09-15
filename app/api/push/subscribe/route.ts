import { NextResponse } from 'next/server';

import { checkPassphrase, parseSubscription, saveSubscription } from '@/lib/pushSubscription';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Registers a device for the morning notification.
//
// Publicly reachable and unauthenticated by default — see lib/pushSubscription.ts
// for what stands between it and the table. The 401 body names the reason so the
// toggle can tell "ask the user for the passphrase" apart from "that one was
// wrong", which are different things to show someone.
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

  const result = await saveSubscription(sub, request.headers.get('user-agent'));
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ ok: true });
}
