import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from './supabaseAdmin';
import { collectAllHeadlines } from './feeds';
import { scrapeArticles, firecrawlConfigured } from './firecrawl';
import { openScrapeBudget, DAILY_SCRAPE_LIMIT } from './scrapeBudget';
import {
  TOPIC_HISTORY_DAYS,
  addUsage,
  chooseArticles,
  createClient,
  emptyUsage,
  logUsage,
  partition,
  shortlistHeadlines,
  writeArticle,
  type CategoryCandidates,
  type CategoryShortlist,
} from './openai';
import { getRecentTopics } from './queries';
import { berlinDateString } from './dates';
import { isLearnableVocab } from './vocab';
import { CATEGORY_ORDER, type GeneratedArticle, type VocabRow } from './types';
import { envNumberMin, envPositive } from './env';

// ---------------------------------------------------------------------------
// The whole daily run, in one place.
//
// This used to live inside the Vercel cron route. It moved out because the
// pipeline grew from "one model call per category" to six stages, which does
// not fit the 60s Hobby function ceiling — the scheduled run is now a GitHub
// Actions job (scripts/run-briefing.ts) with no time limit. The Vercel route
// still calls this exact function for the in-app "generate now" button, just
// with a tighter deadline.
//
// Stages:
//   1. RSS       — a wide slate of real headlines per category (free, fast)
//   2. SHORTLIST — one model call ranks the best few headlines per category,
//                  avoiding the subjects covered in the last TOPIC_HISTORY_DAYS
//   3. SCRAPE    — Firecrawl fetches the whole shortlist (4-6 pages per
//                  category), under a hard daily ceiling of DAILY_SCRAPE_LIMIT
//   4. CHOOSE    — one model call reads what came back and picks the single
//                  most interesting article per category
//   5. WRITE     — one model call per category turns it into a B2 piece
//   6. PERSIST   — articles, vocabulary, push
//
// Stages 3-4 are why the briefing no longer writes about whatever the headline
// happened to promise: a headline is a weak signal, and a story that reads as
// a scoop is routinely a two-line agency snippet or a paywall teaser once you
// fetch it. Scraping a shortlist and choosing from the text costs more credits
// than scraping one page per category did, which is exactly why the day's
// scrapes are capped and counted in the database — see lib/scrapeBudget.ts.
// ---------------------------------------------------------------------------

// Budget for stages 2-5. Generous by default (the Actions runner has no ceiling);
// the Vercel route passes something much tighter.
const DEFAULT_DEADLINE_MS = envPositive('BRIEFING_DEADLINE_MS', 10 * 60_000);

// The shortlist and choice calls are single cheap requests, but each blocks
// everything after it, so cap them rather than letting one eat the whole budget.
// SELECTION_TIMEOUT_MS is the shortlist call's former name, still honoured.
const SHORTLIST_TIMEOUT_MS = envPositive(
  'SHORTLIST_TIMEOUT_MS',
  envPositive('SELECTION_TIMEOUT_MS', 60_000),
);
const CHOICE_TIMEOUT_MS = envPositive('CHOICE_TIMEOUT_MS', 60_000);

// How many articles to fetch per category. Five categories at the default 6 is
// exactly DAILY_SCRAPE_LIMIT (30), so a normal day spends the budget once and
// stops; a second, forced run that day gets whatever is left, or nothing.
const SCRAPES_PER_CATEGORY = envNumberMin('FIRECRAWL_SCRAPES_PER_CATEGORY', 6, 1);

// Below this the choice step is choosing from too little to be worth much —
// worth a line in the log so a shrinking budget is visible rather than silent.
const COMFORTABLE_SCRAPES_PER_CATEGORY = 4;

// The share of the remaining budget that scraping may use. Fetching 30 pages is
// the slowest stage by far, and it must not leave the writing stage with no time
// at all — particularly on the Vercel route, which has a 60s ceiling.
const SCRAPE_TIME_SHARE = Math.min(0.9, envPositive('BRIEFING_SCRAPE_TIME_SHARE', 0.5));

export interface RunOptions {
  /** Defaults to today in Europe/Berlin. */
  date?: string;
  /** Regenerate even if a completed briefing already exists for the date. */
  force?: boolean;
  /** Budget in ms for the model+scrape stages. */
  deadlineMs?: number;
  /**
   * How many articles to scrape per category (default FIRECRAWL_SCRAPES_PER_CATEGORY,
   * i.e. 6). The daily ceiling still applies on top of this. Lower it on a
   * time-boxed path like the Vercel route, which cannot wait for 30 fetches.
   */
  scrapesPerCategory?: number;
  /** Called after articles are written to the DB (used to bust the ISR cache). */
  onPersisted?: (date: string) => void | Promise<void>;
  /** Skip the push notification (handy when re-running to fix the website only). */
  skipNotify?: boolean;
}

export interface RunResult {
  ok: boolean;
  date: string;
  skipped: boolean;
  articles: number;
  /** Non-fatal per-category failures, for the caller to log or surface. */
  errors: string[];
}

// Turn a shortlist into "everything we managed to fetch for it", inside the
// day's scrape ceiling.
//
// Credits are claimed up front for the whole batch, then handed back for
// anything the deadline stopped us attempting — so the counter always reflects
// pages we really asked Firecrawl for. A category whose scrapes all fail keeps
// its candidates with null text and is written from the feed summary instead;
// scraping is best-effort at every level, never fatal.
async function scrapeShortlist(
  supabase: SupabaseClient,
  today: string,
  shortlist: CategoryShortlist[],
  deadline: number,
): Promise<CategoryCandidates[]> {
  const unscraped: CategoryCandidates[] = shortlist.map((group) => ({
    category: group.category,
    candidates: group.candidates.map((selection) => ({ selection, scraped: null })),
  }));

  if (!firecrawlConfigured()) return unscraped;

  const budget = await openScrapeBudget(supabase, today);
  const wanted = shortlist.reduce((n, group) => n + group.candidates.length, 0);
  const granted = await budget.claim(wanted);

  if (granted === 0) {
    console.warn(
      `[scrape] ${today}: no scrape credits left today (limit ${budget.limit}) — ` +
        'every article will be written from its feed summary.',
    );
    return unscraped;
  }
  if (granted < wanted) {
    console.warn(
      `[scrape] ${today}: only ${granted} of ${wanted} shortlisted pages fit in today's ` +
        `limit of ${budget.limit} — the rest of the shortlist is dropped.`,
    );
  }

  // Spend the credits rank-first: every category gets its best candidate before
  // any category gets its second. A short budget then costs each category the
  // same amount of choice instead of starving whichever comes last.
  const urls: string[] = [];
  const depth = Math.max(0, ...shortlist.map((g) => g.candidates.length));
  for (let rank = 0; rank < depth && urls.length < granted; rank++) {
    for (const group of shortlist) {
      if (urls.length >= granted) break;
      const candidate = group.candidates[rank];
      if (candidate) urls.push(candidate.headline.url);
    }
  }

  // Leave the writing stage some of the budget: 30 fetches is the slowest thing
  // the run does, and an article written from a feed summary still beats no
  // article at all.
  const scrapeDeadline = Date.now() + Math.max(0, (deadline - Date.now()) * SCRAPE_TIME_SHARE);
  console.log(`[scrape] ${today}: fetching ${urls.length} shortlisted page(s).`);
  const { results, attempted, skipped } = await scrapeArticles(urls, { deadline: scrapeDeadline });

  // Hand back what the deadline stopped us from spending.
  if (granted > attempted) await budget.release(granted - attempted);
  if (skipped.length) {
    console.warn(`[scrape] ${today}: ran out of time before ${skipped.length} shortlisted page(s).`);
  }

  return shortlist.map((group) => ({
    category: group.category,
    candidates: group.candidates.map((selection) => ({
      selection,
      scraped: results.get(selection.headline.url) ?? null,
    })),
  }));
}

export async function runBriefing(options: RunOptions = {}): Promise<RunResult> {
  const today = options.date ?? berlinDateString();
  const force = options.force ?? false;
  const supabase = getSupabaseAdmin();

  // Duplicate guard: skip if today's briefing already completed — unless this is
  // a forced on-demand run, which regenerates a fresh set for today.
  const { data: existingRun } = await supabase
    .from('briefing_runs')
    .select('*')
    .eq('briefing_date', today)
    .maybeSingle();

  if (!force && existingRun?.status === 'completed') {
    return { ok: true, date: today, skipped: true, articles: 0, errors: [] };
  }

  await supabase
    .from('briefing_runs')
    .upsert(
      { briefing_date: today, status: 'pending', error_message: null, push_sent: 0 },
      { onConflict: 'briefing_date' },
    );

  try {
    if (!firecrawlConfigured()) {
      console.warn(
        '[briefing] FIRECRAWL_API_KEY is not set — every article will be written from its feed summary only.',
      );
    } else if (DAILY_SCRAPE_LIMIT === 0) {
      console.warn(
        '[briefing] FIRECRAWL_DAILY_LIMIT is 0 — scraping is disabled, so every article ' +
          'will be written from its feed summary only.',
      );
    }

    const deadline = Date.now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
    const totals = emptyUsage();
    const errors: string[] = [];
    let attempts = 0;

    // --- Stage 1: the slate, the history, and the vocabulary (all in parallel).
    const [candidates, recentTopics, vocabResult] = await Promise.all([
      collectAllHeadlines(today),
      TOPIC_HISTORY_DAYS > 0 ? getRecentTopics(TOPIC_HISTORY_DAYS, today) : Promise.resolve([]),
      supabase
        .from('vocabulary')
        .select('*')
        .order('times_used_total', { ascending: true })
        .order('last_used_date', { ascending: true, nullsFirst: true }),
    ]);

    if (vocabResult.error) {
      throw new Error(`Failed to load vocabulary: ${vocabResult.error.message}`);
    }
    const vocab = (vocabResult.data ?? []) as VocabRow[];
    console.log(
      `[briefing] ${today}: ${recentTopics.length} recent topics to avoid, ${vocab.length} vocabulary words.`,
    );

    // --- Stage 2: shortlist the best few headlines per category.
    const client = createClient();
    const perCategory = Math.max(
      1,
      Math.floor(options.scrapesPerCategory ?? SCRAPES_PER_CATEGORY),
    );
    if (perCategory < COMFORTABLE_SCRAPES_PER_CATEGORY) {
      console.log(
        `[briefing] shortlisting only ${perCategory} article(s) per category — ` +
          'the choice step has little to compare.',
      );
    }
    const shortlistTimeout = Math.min(SHORTLIST_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
    const shortlisted = await shortlistHeadlines(
      client,
      today,
      candidates,
      recentTopics,
      perCategory,
      shortlistTimeout,
    );
    addUsage(totals, shortlisted.usage);

    // --- Stage 3: fetch the shortlist, inside the day's scrape ceiling.
    const scrapedGroups = await scrapeShortlist(supabase, today, shortlisted.shortlist, deadline);

    // --- Stage 4: pick the one article per category worth writing about.
    const choiceTimeout = Math.min(CHOICE_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
    const chosen = await chooseArticles(client, today, scrapedGroups, recentTopics, choiceTimeout);
    addUsage(totals, chosen.usage);
    const choices = chosen.choices;

    // Each category gets a different slice of the vocabulary list, so the same
    // few least-used words don't turn up in all five articles.
    const focusBuckets = partition(vocab, Math.max(1, choices.length));

    // --- Stage 5: write, one independent call per category, all in flight at
    // once. A category that fails is dropped, never fatal.
    const settled = await Promise.allSettled(
      choices.map((choice, i) =>
        writeArticle(
          client,
          today,
          choice.selection,
          choice.scraped,
          focusBuckets[i] ?? [],
          vocab,
          deadline,
        ),
      ),
    );

    const articles: GeneratedArticle[] = [];
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        articles.push(result.value.article);
        attempts += result.value.attempts;
        addUsage(totals, result.value.usage);
      } else {
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push(`${choices[i].category}: ${reason}`);
      }
    });

    logUsage(today, totals, articles.length, attempts);

    if (articles.length === 0) {
      throw new Error(`Every category failed to generate. ${errors.join(' | ')}`);
    }
    if (errors.length > 0) {
      console.error(`runBriefing: ${errors.length} category/categories failed — ${errors.join(' | ')}`);
    }

    articles.sort(
      (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
    );

    // --- Stage 6: persist, refresh the site, update vocabulary, notify.
    await supabase.from('articles').delete().eq('briefing_date', today);
    const rows = articles.map((a) => ({
      briefing_date: today,
      category: a.category,
      title_en: a.title_en,
      source_url: a.source_url ?? null,
      summary_en: a.summary_en,
      topic_tag: a.topic_tag || null,
      title_de: a.title_de,
      content_de: a.content_de,
      footnotes: a.footnotes ?? [],
      vocab_used: a.vocab_used ?? [],
      vocab_new: (a.vocab_new ?? []).map((v) => v.german),
    }));
    const { error: insertErr } = await supabase.from('articles').insert(rows);
    if (insertErr) throw new Error(`Failed to insert articles: ${insertErr.message}`);

    await options.onPersisted?.(today);

    await updateVocabulary(supabase, vocab, articles, today);

    await supabase
      .from('briefing_runs')
      .update({ status: 'completed', push_sent: 0, error_message: null })
      .eq('briefing_date', today);

    return { ok: true, date: today, skipped: false, articles: articles.length, errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await supabase
      .from('briefing_runs')
      .update({ status: 'failed', error_message: message })
      .eq('briefing_date', today);
    throw err;
  }
}

async function updateVocabulary(
  supabase: SupabaseClient,
  vocab: VocabRow[],
  articles: GeneratedArticle[],
  today: string,
): Promise<void> {
  // Count how many articles used each known word.
  const usedCounts = new Map<string, number>();
  for (const a of articles) {
    for (const w of a.vocab_used ?? []) {
      usedCounts.set(w, (usedCounts.get(w) ?? 0) + 1);
    }
  }

  const byWord = new Map(vocab.map((v) => [v.german_word, v] as const));
  for (const [word, count] of usedCounts) {
    const row = byWord.get(word);
    if (!row) continue; // unknown words are handled as "new" below
    await supabase
      .from('vocabulary')
      .update({ times_used_total: row.times_used_total + count, last_used_date: today })
      .eq('id', row.id);
  }

  // Insert brand-new words the model introduced (skip any that already exist).
  // The same learnability rules apply here as to the footnotes: this table is
  // your actual study list, so a name or an acronym must never reach it, even if
  // one somehow survived the earlier filter.
  const known = new Set(vocab.map((v) => v.german_word));
  const newWords = new Map<string, string>();
  for (const a of articles) {
    for (const nv of a.vocab_new ?? []) {
      if (!nv?.german || known.has(nv.german) || newWords.has(nv.german)) continue;
      if (!isLearnableVocab(nv.german)) continue;
      newWords.set(nv.german, nv.english ?? '');
    }
  }
  if (newWords.size > 0) {
    const newRows = [...newWords.entries()].map(([german, english]) => ({
      german_word: german,
      english_translation: english,
      cefr_level: 'B2',
      date_first_introduced: today,
      times_used_total: 1,
      last_used_date: today,
    }));
    await supabase
      .from('vocabulary')
      .upsert(newRows, { onConflict: 'german_word', ignoreDuplicates: true });
  }
}
