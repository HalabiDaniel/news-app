import { NextResponse } from 'next/server';
import { revalidatePath } from 'next/cache';
import { runBriefing } from '@/lib/briefing';
import { berlinDateString } from '@/lib/dates';
import { envNumberMin, envPositive } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 60s is the Vercel Hobby ceiling. The SCHEDULED run no longer happens here —
// it's a GitHub Actions job (see .github/workflows/daily-briefing.yml), which has
// no time limit and can take the pipeline at its natural pace. This endpoint
// exists for the in-app "generate now" button and manual runs, so it passes a
// deliberately tight deadline to runBriefing and accepts that a slow morning may
// yield fewer than five articles rather than a 504 with nothing saved.
export const maxDuration = 60;

// Leave headroom inside the 60s ceiling for the DB writes that follow the model
// stages. Override with BRIEFING_ROUTE_DEADLINE_MS.
const ROUTE_DEADLINE_MS = envPositive('BRIEFING_ROUTE_DEADLINE_MS', 45_000);

// The scheduled run scrapes 6 articles per category and picks the best; 30
// fetches is comfortably the slowest stage and does not fit in 60s. This path
// therefore shortlists just two per category — still a real choice made on real
// article text, but one that fits the ceiling. It draws on the same daily
// budget, so a manual run can't push the day over the Firecrawl limit either.
const ROUTE_SCRAPES_PER_CATEGORY = envNumberMin('BRIEFING_ROUTE_SCRAPES_PER_CATEGORY', 2, 1);

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  // The in-app "generate now" button sends this header (with a key you enter once).
  if (request.headers.get('authorization') === `Bearer ${secret}`) return true;

  // Convenience fallback for manual mobile testing: /api/cron/daily-briefing?key=...
  // (keep the secret long and random; query strings can end up in logs).
  const url = new URL(request.url);
  return url.searchParams.get('key') === secret;
}

// On-demand runs (the "generate now" button, or ?force=1) bypass the once-a-day
// guard so you can pull a fresh set of articles whenever you like.
function forced(request: Request): boolean {
  const value = new URL(request.url).searchParams.get('force');
  return value === '1' || value === 'true';
}

async function handle(request: Request): Promise<NextResponse> {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const today = berlinDateString();

  try {
    const result = await runBriefing({
      date: today,
      force: forced(request),
      deadlineMs: ROUTE_DEADLINE_MS,
      scrapesPerCategory: ROUTE_SCRAPES_PER_CATEGORY,
      // Every page a new briefing changes uses ISR, so without this they'd keep
      // serving stale markup for up to five minutes — the button would report
      // success and the site would still show nothing. Same four paths as
      // /api/revalidate, which is what the scheduled run pings.
      onPersisted: (date) => {
        for (const path of ['/', '/archiv', `/archiv/${date}`, '/vokabeln']) {
          revalidatePath(path);
        }
      },
    });

    if (result.skipped) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        message: 'Briefing already completed for today.',
        date: result.date,
      });
    }

    return NextResponse.json({
      ok: true,
      date: result.date,
      articles: result.articles,
      errors: result.errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message, date: today }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
