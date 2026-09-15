import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { berlinDateString } from '@/lib/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The scheduled run happens in GitHub Actions now, which writes straight to
// Supabase and never touches this deployment. The site's pages use ISR
// (`revalidate = 300`), so without a nudge they'd serve stale markup for up to
// five minutes after the briefing lands — the email would arrive before the
// website updated. The Actions job pings this endpoint when it's done.
export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const date = new URL(request.url).searchParams.get('date') || berlinDateString();

  revalidatePath('/');
  revalidatePath('/archive');
  revalidatePath(`/archive/${date}`);

  return NextResponse.json({ ok: true, revalidated: ['/', '/archive', `/archive/${date}`] });
}
