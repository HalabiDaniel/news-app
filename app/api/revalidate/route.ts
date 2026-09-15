import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { berlinDateString } from '@/lib/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The scheduled run happens in GitHub Actions now, which writes straight to
// Supabase and never touches this deployment. The site's pages use ISR
// (`revalidate = 300`), so without a nudge they'd serve stale markup for up to
// five minutes after the briefing lands. The Actions job pings this endpoint
// when it's done — BEFORE it sends the push notification, because the
// notification is only a ping and the article has to be there the moment it is
// tapped.
export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const date = new URL(request.url).searchParams.get('date') || berlinDateString();

  // The four routes a new briefing changes: today, the archive index (a new
  // day appears in it), that day's own page, and the vocabulary list (every
  // run adds words and bumps the counts the page sorts by).
  const paths = ['/', '/archiv', `/archiv/${date}`, '/vokabeln'];
  for (const path of paths) revalidatePath(path);

  return NextResponse.json({ ok: true, revalidated: paths });
}
