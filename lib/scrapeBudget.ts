import type { SupabaseClient } from '@supabase/supabase-js';
import { envNumberMin } from './env';

// ---------------------------------------------------------------------------
// The hard daily ceiling on Firecrawl scrapes.
//
// The pipeline no longer scrapes one page per category — it scrapes a shortlist
// of 4-6 per category and then picks the most interesting one from the actual
// text. That is a much better editorial decision, but it also multiplies the
// number of pages fetched by six, so the spend needs a real ceiling rather than
// "whatever the run happens to ask for".
//
// The ceiling is a COUNT OF ATTEMPTS, not of successes: a paywalled page, a
// timeout, and a clean fetch all cost the same credit, so all three are counted.
//
// The counter lives in Postgres, keyed by date, because the limit has to hold
// across *runs*, not just within one. The scheduled GitHub Actions job, the
// in-app "generate now" button, and a local `npm run briefing -- --force` are
// three separate processes that can all happen on the same day; an in-process
// counter would let each of them spend the full 30.
//
// Credits are claimed BEFORE the scrapes are attempted, so a crash mid-batch
// can only ever under-spend the budget, never overshoot it. Anything the run
// claimed but decided not to attempt is handed back with release().
// ---------------------------------------------------------------------------

const TABLE = 'scrape_budget';

/**
 * Attempts allowed per calendar day, across every run. Read through
 * lib/env.ts so an explicit 0 ("don't scrape at all") survives, and a blank
 * value from GitHub Actions or Vercel reads as unset rather than as 0.
 */
export const DAILY_SCRAPE_LIMIT = envNumberMin('FIRECRAWL_DAILY_LIMIT', 30, 0);

// The claim is a compare-and-set (update ... where scrapes_used = <what we
// read>), so two runs racing on the same row can't both spend the same credits.
// The loser of a race simply re-reads and tries again.
const MAX_CLAIM_ATTEMPTS = 5;

export interface ScrapeBudget {
  /** The daily ceiling this budget enforces. */
  readonly limit: number;
  /** Credits already spent today when the budget was opened. */
  readonly usedAtStart: number;
  /** True when the count is only per-process (the table is missing). */
  readonly inMemoryOnly: boolean;
  /**
   * Reserve up to `count` scrape attempts. Returns how many were actually
   * granted — 0 when the day's budget is gone. Never throws.
   */
  claim(count: number): Promise<number>;
  /** Hand back credits that were claimed but not attempted. Never throws. */
  release(count: number): Promise<void>;
}

// A budget that only counts within this process. Used when the table isn't
// there yet (an older database that hasn't re-run schema.sql) or when Postgres
// is unreachable. It still enforces the per-run ceiling, which is the common
// case, and it is loud about the weaker guarantee.
function memoryBudget(limit: number, used = 0): ScrapeBudget {
  let spent = used;
  return {
    limit,
    usedAtStart: used,
    inMemoryOnly: true,
    async claim(count: number): Promise<number> {
      const granted = Math.max(0, Math.min(count, limit - spent));
      spent += granted;
      return granted;
    },
    async release(count: number): Promise<void> {
      spent = Math.max(0, spent - Math.max(0, count));
    },
  };
}

async function readUsed(
  supabase: SupabaseClient,
  date: string,
): Promise<{ ok: true; used: number | null } | { ok: false }> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('scrapes_used')
    .eq('scrape_date', date)
    .maybeSingle();
  if (error) {
    console.warn(`[budget] could not read today's scrape count: ${error.message}`);
    return { ok: false };
  }
  // null = no row for today yet, i.e. nothing spent.
  return { ok: true, used: data ? Number((data as { scrapes_used: number }).scrapes_used) || 0 : null };
}

// Move the counter by `delta` (negative to give credits back), returning true
// only if OUR read of the row was still current when the write landed.
async function compareAndSet(
  supabase: SupabaseClient,
  date: string,
  observed: number | null,
  delta: number,
): Promise<boolean> {
  const next = Math.max(0, (observed ?? 0) + delta);

  if (observed === null) {
    const { error } = await supabase.from(TABLE).insert({ scrape_date: date, scrapes_used: next });
    // A concurrent run inserted the row first: not an error, just a lost race.
    if (error) return false;
    return true;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({ scrapes_used: next, updated_at: new Date().toISOString() })
    .eq('scrape_date', date)
    .eq('scrapes_used', observed)
    .select('scrapes_used');
  if (error) {
    console.warn(`[budget] could not update today's scrape count: ${error.message}`);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Open today's scrape budget. Falls back to a per-process counter (with a
 * warning) if the `scrape_budget` table is missing or unreachable — a budget
 * problem must never be the reason a briefing fails to generate.
 */
export async function openScrapeBudget(
  supabase: SupabaseClient,
  date: string,
  limit: number = DAILY_SCRAPE_LIMIT,
): Promise<ScrapeBudget> {
  const initial = await readUsed(supabase, date);
  if (!initial.ok) {
    console.warn(
      `[budget] falling back to an in-process limit of ${limit} scrape(s) — ` +
        `run supabase/schema.sql to create the "${TABLE}" table so the cap holds across runs.`,
    );
    return memoryBudget(limit);
  }

  const usedAtStart = initial.used ?? 0;
  console.log(
    `[budget] ${date}: ${usedAtStart}/${limit} Firecrawl scrape(s) already used today.`,
  );

  return {
    limit,
    usedAtStart,
    inMemoryOnly: false,

    async claim(count: number): Promise<number> {
      const want = Math.max(0, Math.floor(count));
      if (want === 0 || limit === 0) return 0;

      for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
        const current = await readUsed(supabase, date);
        if (!current.ok) return 0; // can't prove we're under the cap → don't spend

        const used = current.used ?? 0;
        const granted = Math.min(want, limit - used);
        if (granted <= 0) {
          console.warn(
            `[budget] ${date}: daily Firecrawl limit of ${limit} reached — no more scrapes today.`,
          );
          return 0;
        }

        if (await compareAndSet(supabase, date, current.used, granted)) {
          console.log(
            `[budget] ${date}: claimed ${granted} scrape(s) (${used + granted}/${limit} used).`,
          );
          return granted;
        }
        // Someone else moved the counter between our read and our write.
      }

      console.warn(
        `[budget] ${date}: gave up claiming scrape credits after ${MAX_CLAIM_ATTEMPTS} attempts.`,
      );
      return 0;
    },

    async release(count: number): Promise<void> {
      const give = Math.max(0, Math.floor(count));
      if (give === 0) return;

      for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
        const current = await readUsed(supabase, date);
        if (!current.ok || current.used === null) return;
        if (await compareAndSet(supabase, date, current.used, -give)) {
          console.log(`[budget] ${date}: released ${give} unused scrape credit(s).`);
          return;
        }
      }
      // Losing this race only means the day looks slightly more expensive than
      // it was. Never worth failing a run over.
      console.warn(`[budget] ${date}: could not release ${give} unused scrape credit(s).`);
    },
  };
}
