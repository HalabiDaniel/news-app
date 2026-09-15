import { getSupabaseAdmin } from './supabaseAdmin';
import { CATEGORY_ORDER, type ArticleRow, type RecentTopic } from './types';
import { envPositive } from './env';

// All errors are swallowed to an empty result so pages render an empty state
// instead of crashing (e.g. during build with no env vars, or a transient DB blip).

// These reads run inside the homepage/archive server render. A DB call that
// *hangs* (unreachable host, network black hole) would otherwise stall the render
// until Vercel kills it with a 504 — so cap every query and fall back to the
// empty state instead. Overridable via SUPABASE_QUERY_TIMEOUT_MS.
const QUERY_TIMEOUT_MS = envPositive('SUPABASE_QUERY_TIMEOUT_MS', 8_000);

export async function getArticlesForDate(date: string): Promise<ArticleRow[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .eq('briefing_date', date)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
    if (error || !data) return [];
    return (data as ArticleRow[]).sort(
      (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
    );
  } catch {
    return [];
  }
}

export async function getBriefingDates(): Promise<string[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('articles')
      .select('briefing_date')
      .order('briefing_date', { ascending: false })
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
    if (error || !data) return [];

    const seen = new Set<string>();
    const dates: string[] = [];
    for (const row of data as { briefing_date: string }[]) {
      if (!seen.has(row.briefing_date)) {
        seen.add(row.briefing_date);
        dates.push(row.briefing_date);
      }
    }
    return dates;
  } catch {
    return [];
  }
}

// The stories already covered in the last N days, newest first.
//
// This is the memory behind the diversity check. The generation path used to
// read NOTHING from the `articles` table on purpose (to keep prompts small), but
// that is exactly why the briefing repeated itself: with no record of yesterday,
// every day started from a blank slate and re-picked the same lead stories.
//
// What's read back is deliberately minimal — a date, a category, a title, and
// the short topic tag — so the selection prompt stays cheap no matter how long
// the archive grows.
export async function getRecentTopics(
  days: number,
  beforeDate: string,
): Promise<RecentTopic[]> {
  try {
    const supabase = getSupabaseAdmin();
    const since = new Date(Date.parse(`${beforeDate}T00:00:00Z`) - days * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const { data, error } = await supabase
      .from('articles')
      .select('briefing_date, category, title_de, topic_tag')
      .gte('briefing_date', since)
      // Strictly BEFORE today, so a forced re-run doesn't treat the articles it
      // is about to replace as "already covered" and rule out every good story.
      .lt('briefing_date', beforeDate)
      .order('briefing_date', { ascending: false })
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
    if (error || !data) return [];
    return data as RecentTopic[];
  } catch {
    return [];
  }
}
