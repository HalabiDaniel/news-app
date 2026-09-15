import { getSupabaseAdmin } from './supabaseAdmin';
import {
  CATEGORY_ORDER,
  type ArticleRow,
  type Category,
  type RecentTopic,
  type VocabRow,
} from './types';
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

// ---------------------------------------------------------------------------
// Phase 4 reads: the archive index, the vocabulary page, and the run status
// that lets the empty state tell "not yet" apart from "something broke".
// ---------------------------------------------------------------------------

// One past day, with enough of its content to be recognisable in a list.
//
// The old archive index was a bare list of dates, which stops being usable
// somewhere around two weeks: you remember the article, never the date. Each
// day carries its five German titles so the index can be skimmed.
export interface ArchiveDay {
  date: string;
  titles: { category: Category; title_de: string }[];
}

export async function getArchiveIndex(): Promise<ArchiveDay[]> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('articles')
      .select('briefing_date, category, title_de')
      .order('briefing_date', { ascending: false })
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
    if (error || !data) return [];

    const byDate = new Map<string, ArchiveDay>();
    for (const row of data as { briefing_date: string; category: Category; title_de: string }[]) {
      let day = byDate.get(row.briefing_date);
      if (!day) {
        day = { date: row.briefing_date, titles: [] };
        byDate.set(row.briefing_date, day);
      }
      day.titles.push({ category: row.category, title_de: row.title_de.replace(/\*\*/g, '') });
    }
    for (const day of byDate.values()) {
      day.titles.sort(
        (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
      );
    }
    // Supabase returned the rows newest-first; Map preserves insertion order.
    return [...byDate.values()];
  } catch {
    return [];
  }
}

// The status row for one day. `null` means no row at all — which is a different
// thing from `failed`, and the empty state says so: a missing row before the
// run is simply "not yet", a missing row hours afterwards is the signal that
// the workflow never started (the 60-day auto-disable looks exactly like this).
export interface BriefingRunRow {
  briefing_date: string;
  status: 'pending' | 'completed' | 'failed' | string;
  error_message: string | null;
  push_sent: number | null;
}

export async function getBriefingRun(date: string): Promise<BriefingRunRow | null> {
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('briefing_runs')
      .select('briefing_date, status, error_message, push_sent')
      .eq('briefing_date', date)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS))
      .maybeSingle();
    if (error || !data) return null;
    return data as BriefingRunRow;
  } catch {
    return null;
  }
}

// The most recent date that actually has articles. This is the staleness
// monitor behind the empty state: "Letztes Briefing: vor 3 Tagen" is a working
// alarm you happen to read every morning.
export async function getLatestBriefingDate(before?: string): Promise<string | null> {
  try {
    const supabase = getSupabaseAdmin();
    let query = supabase
      .from('articles')
      .select('briefing_date')
      .order('briefing_date', { ascending: false })
      .limit(1);
    if (before) query = query.lt('briefing_date', before);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
    if (error || !data || data.length === 0) return null;
    return (data[0] as { briefing_date: string }).briefing_date;
  } catch {
    return null;
  }
}

// A vocabulary entry plus the day it was introduced on, so /vokabeln can link
// back to the article the word came from.
export interface VocabEntry extends VocabRow {
  source: { date: string; title_de: string } | null;
}

// Every accumulated word, least-seen first — the order that makes the page a
// revision list rather than a dump. Ties break on the oldest last_used_date,
// so a word you saw once a month ago sorts above one you saw once yesterday.
//
// The `articles` scan that finds each word's origin reads three small columns;
// it is one query, not one per word.
export async function getVocabulary(limit = 1000): Promise<VocabEntry[]> {
  try {
    const supabase = getSupabaseAdmin();
    const [vocabRes, articleRes] = await Promise.all([
      supabase
        .from('vocabulary')
        .select('*')
        .order('times_used_total', { ascending: true })
        .order('last_used_date', { ascending: true, nullsFirst: true })
        .limit(limit)
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
      supabase
        .from('articles')
        .select('briefing_date, title_de, vocab_new')
        .order('briefing_date', { ascending: false })
        .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS)),
    ]);

    if (vocabRes.error || !vocabRes.data) return [];

    // word (lowercased) → the OLDEST article that introduced it, since that is
    // where you first met it. Rows arrive newest-first, so later writes win.
    const origin = new Map<string, { date: string; title_de: string }>();
    for (const row of (articleRes.data ?? []) as {
      briefing_date: string;
      title_de: string;
      vocab_new: string[] | null;
    }[]) {
      for (const word of row.vocab_new ?? []) {
        if (typeof word !== 'string') continue;
        origin.set(word.trim().toLowerCase(), {
          date: row.briefing_date,
          title_de: row.title_de.replace(/\*\*/g, ''),
        });
      }
    }

    return (vocabRes.data as VocabRow[]).map((row) => ({
      ...row,
      source: origin.get(row.german_word.trim().toLowerCase()) ?? null,
    }));
  } catch {
    return [];
  }
}

// Is the database actually answering?
//
// Every read above swallows its errors to an empty result, which is what keeps
// a build with no credentials (and a transient blip) from crashing the site —
// but it also makes "the database is down" look exactly like "there is no
// briefing yet". Phase 4.6 says to decide that deliberately rather than
// discover it during an outage, so the empty state calls this one probe (and
// only when it has nothing else to show) to tell the two apart.
export async function isDatabaseReachable(): Promise<boolean> {
  try {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from('vocabulary')
      .select('id')
      .limit(1)
      .abortSignal(AbortSignal.timeout(QUERY_TIMEOUT_MS));
    return !error;
  } catch {
    // getSupabaseAdmin throws when the env vars are missing — which during a
    // credential-less CI build is "unreachable", and correctly so.
    return false;
  }
}
