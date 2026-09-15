import OpenAI from 'openai';
import {
  CATEGORY_ORDER,
  type Category,
  type Footnote,
  type GeneratedArticle,
  type RecentTopic,
  type VocabRow,
} from './types';
import type { Headline } from './feeds';
import type { ScrapedArticle } from './firecrawl';
import { checkVocabWord } from './vocab';
import { envEnum, envNumber, envNumberMin, envPositive, envString } from './env';

// ---------------------------------------------------------------------------
// The model side of the pipeline, in three distinct steps.
//
// It used to be one step: hand each category a `web_search` tool and say "find a
// current story and write about it". That produced the sameness problem — the
// model had no idea what it wrote yesterday, and searching "German politics
// news" reliably surfaces whatever the big outlets are leading with. So Politik
// was perpetually about the chancellor and Finanzen perpetually about the DAX.
//
// Now:
//   1. SHORTLIST — one call, all five categories at once. It sees a wide slate
//      of real RSS headlines plus the topics of the last week, and ranks the
//      handful per category that look genuinely NEW relative to that history.
//      These, and only these, are the pages Firecrawl then fetches.
//   2. CHOOSE — one call over the text that actually came back, picking the one
//      article per category worth writing. A headline is a weak signal: plenty
//      turn out to be liveblogs, agency snippets or paywall teasers, and that
//      is only visible once you can read them.
//   3. WRITE — one call per category, over the text of the article that won.
//      No search, no browsing, no invention.
//
// Splitting them is also what makes the diversity check possible at all: you
// cannot compare against yesterday if you never see the list of options.
// ---------------------------------------------------------------------------

export const DEFAULT_MODEL = 'gpt-5.5-mini';
// Model ids come and go on an account, so this one is only a default: set
// OPENAI_MODEL to whatever small model your key actually has. Run
// `npm run check-models` to see the list. Note that setting it in the GitHub
// or Vercel UI is not enough for the scheduled run — the Actions workflow has
// to map it into the job's `env:` block too (.github/workflows/daily-briefing.yml).
export const MODEL = envString('OPENAI_MODEL') ?? DEFAULT_MODEL;

// --- Timeouts ---------------------------------------------------------------
// Under GitHub Actions there is no function ceiling, so these are generous
// safety valves rather than the load-bearing constraint they were on Vercel.
// The Vercel manual-trigger path passes a tighter deadline of its own.
const REQUEST_TIMEOUT_MS = envPositive('OPENAI_TIMEOUT_MS', 90_000);
const MAX_RETRIES = envNumberMin('OPENAI_MAX_RETRIES', 0, 0);
const REASONING_EFFORT = envEnum('OPENAI_REASONING_EFFORT', 'low');

// --- Cost controls ----------------------------------------------------------
// Dropping `web_search` removed the single most expensive thing this app did:
// every page the tool retrieved was billed back as input tokens, on every
// category, every day. A Firecrawl markdown body is a few thousand tokens and
// is fetched exactly once. These caps bound what's left.
const MAX_OUTPUT_TOKENS = envPositive('OPENAI_MAX_OUTPUT_TOKENS', 6144);
// The shortlist call ranks ~30 headlines rather than picking 5, so it needs more
// reasoning headroom than the old selection call did — a response that runs out
// of tokens comes back `incomplete` and is thrown away.
const SELECT_MAX_OUTPUT_TOKENS = envPositive('OPENAI_SELECT_MAX_OUTPUT_TOKENS', 4096);
const CHOICE_MAX_OUTPUT_TOKENS = envPositive('OPENAI_CHOICE_MAX_OUTPUT_TOKENS', 3072);
// How much of each scraped article the choice step is shown. This is the one
// place where the new shortlist costs real input tokens — up to 30 excerpts in
// a single prompt — so keep it to the opening of the piece, which is where a
// news article says what happened and where a teaser gives itself away.
const CHOICE_EXCERPT_CHARS = envNumberMin('OPENAI_CHOICE_EXCERPT_CHARS', 900, 200);
const KNOWN_VOCAB_LIMIT = envNumberMin('OPENAI_KNOWN_VOCAB_LIMIT', 60, 0);
const FOCUS_VOCAB_LIMIT = envNumberMin('OPENAI_FOCUS_VOCAB_LIMIT', 8, 0);

// --- Quality controls -------------------------------------------------------
const MAX_ATTEMPTS = envNumberMin('OPENAI_MAX_ATTEMPTS', 2, 1);
// How many words each article should gloss. The old instruction was "highlight
// generously", which is a large part of why filler like "KI" ended up in the
// list — padding a long glossary means scraping the barrel. A tight target
// forces the model to spend its slots on words that are actually worth one.
const FOOTNOTES_MIN = envNumberMin('OPENAI_FOOTNOTES_MIN', 8, 1);
const FOOTNOTES_MAX = Math.max(FOOTNOTES_MIN, envPositive('OPENAI_FOOTNOTES_MAX', 12));
// How many days of previously-covered topics the selector is shown.
export const TOPIC_HISTORY_DAYS = envNumberMin('TOPIC_HISTORY_DAYS', 7, 0);

const MIN_ATTEMPT_MS = 10_000;

const CATEGORY_DESC: Record<Category, string> = {
  politics: 'politics',
  finance: 'finance / economy',
  technology: 'technology',
  gaming: 'gaming / video games',
  germany: 'life in Germany (society, science, everyday life)',
};

/** One chosen story, resolved back to the real headline it came from. */
export interface Selection {
  category: Category;
  headline: Headline;
  /** Short English label for the subject, stored and fed back as history. */
  topic_tag: string;
  /** The model's one-line justification. Logged, never shown to the reader. */
  reason: string;
}

/** A category's ranked shortlist, best first. These are the pages we scrape. */
export interface CategoryShortlist {
  category: Category;
  candidates: Selection[];
}

/** A shortlisted story paired with whatever Firecrawl managed to fetch for it. */
export interface ScrapedCandidate {
  selection: Selection;
  scraped: ScrapedArticle | null;
}

/** One category's shortlist after the scrape stage. */
export interface CategoryCandidates {
  category: Category;
  candidates: ScrapedCandidate[];
}

/** The single article a category ended up with, ready to be written. */
export interface Choice {
  category: Category;
  selection: Selection;
  scraped: ScrapedArticle | null;
}

export interface UsageLite {
  input: number;
  output: number;
  cached: number;
}

export function emptyUsage(): UsageLite {
  return { input: 0, output: 0, cached: 0 };
}

function addUsage(total: UsageLite, u: UsageLite): void {
  total.input += u.input;
  total.output += u.output;
  total.cached += u.cached;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readUsage(response: any): UsageLite {
  const u = (response?.usage ?? {}) as Record<string, unknown>;
  const details = (u.input_tokens_details ?? {}) as Record<string, unknown>;
  return {
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cached: Number(details.cached_tokens) || 0,
  };
}

export function createClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY environment variable.');
  return new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
}

// The model is asked for raw JSON, but be defensive: strip any code fences and
// slice to the outermost { ... } before parsing.
function extractJson(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in the model output.');
  }
  return t.slice(start, end + 1);
}

/**
 * "The requested model 'x' does not exist" is the one API error whose fix is
 * pure configuration, and the raw message never says where that configuration
 * lives — which, for the scheduled run, is a workflow file rather than the
 * GitHub settings page you'd expect. Say so.
 */
function describeModelError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (!/model/i.test(message) || !/does not exist|not found|do not have access|unsupported/i.test(message)) {
    return err;
  }
  const source = envString('OPENAI_MODEL')
    ? 'from the OPENAI_MODEL environment variable'
    : 'from the built-in default (OPENAI_MODEL is not set in this environment)';
  return new Error(
    `${message}\n` +
      `  The briefing asked for model "${MODEL}", taken ${source}.\n` +
      `  Run \`npm run check-models\` to list the model ids your API key can actually use, then set OPENAI_MODEL to one of them.\n` +
      `  Setting it in the GitHub or Vercel UI is not enough for the scheduled run: GitHub Actions only exposes the variables a workflow maps in, so it must also appear in the job's env: block in .github/workflows/daily-briefing.yml.`,
    { cause: err },
  );
}

// One Responses API call, returning the raw text plus usage. No tools: both
// steps work purely from text we supply, which is what makes them cheap and
// makes fabrication impossible to hide.
async function callModel(
  client: OpenAI,
  prompt: string,
  maxOutputTokens: number,
  timeoutMs: number,
  label: string,
): Promise<{ text: string; usage: UsageLite }> {
  const params: Record<string, unknown> = {
    model: MODEL,
    input: prompt,
    max_output_tokens: maxOutputTokens,
  };
  if (REASONING_EFFORT && REASONING_EFFORT !== 'off' && REASONING_EFFORT !== 'none') {
    params.reasoning = { effort: REASONING_EFFORT };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let response: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    response = await (client as any).responses.create(params, {
      timeout: timeoutMs,
      maxRetries: MAX_RETRIES,
    });
  } catch (err) {
    throw describeModelError(err);
  }

  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown';
    throw new Error(`OpenAI response for ${label} came back incomplete (reason: ${reason}).`);
  }
  const text = response.output_text;
  if (!text || !text.trim()) {
    throw new Error(`OpenAI returned an empty output_text for ${label}.`);
  }
  return { text, usage: readUsage(response) };
}

// ===========================================================================
// STEP 1 — SHORTLIST
// ===========================================================================

export function buildShortlistPrompt(
  today: string,
  candidates: Record<Category, Headline[]>,
  recentTopics: RecentTopic[],
  perCategory: number,
): string {
  // Number the candidates per category. The model answers with these ids rather
  // than a URL, so it is structurally unable to hand back a link that wasn't on
  // the slate — no hallucinated sources, ever.
  const slate = CATEGORY_ORDER.filter((c) => candidates[c]?.length).map((category) => {
    const lines = candidates[category].map((h, i) => {
      const when = h.publishedAt ? h.publishedAt.slice(0, 10) : 'undated';
      const blurb = h.summary ? ` — ${h.summary.slice(0, 180)}` : '';
      return `  [${i}] (${h.source}, ${when}) ${h.title}${blurb}`;
    });
    return `${category} (${CATEGORY_DESC[category]}):\n${lines.join('\n')}`;
  });

  const history = recentTopics.length
    ? recentTopics
        .map(
          (t) =>
            `  - ${t.briefing_date} [${t.category}] ${t.topic_tag ? `${t.topic_tag} — ` : ''}${t.title_de}`,
        )
        .join('\n')
    : '  (nothing yet — this is the first briefing)';

  return `You are the editor of a daily German news briefing for a language learner. Today is ${today}. Your ONLY job right now is to draw up a SHORTLIST of promising stories for each category. You are not choosing the final story and you are not writing anything yet.

Below is a slate of real headlines pulled this morning from German news feeds, grouped by category and numbered.

${slate.join('\n\n')}

These are the stories the briefing ALREADY covered in the last ${TOPIC_HISTORY_DAYS} days:
${history}

For each category in the slate, shortlist the ${perCategory} most promising headlines, BEST FIRST. The full text of every headline you shortlist will be fetched and read, and a later step picks the winner from the actual articles — so your job is to hand that step a strong and genuinely varied set of options, not to guess the single winner.

Obey these rules in order of importance:

1. DIFFERENT SUBJECT. Do not shortlist a story about a subject that appears in the "already covered" list above. Treat a subject as repeated if it centres on the same person, company, organisation, index, product, ongoing dispute, or legislative process — even when the headline is new and the angle has moved on. A second story about the same continuing saga is exactly what makes this briefing feel repetitive, so rule it out.
2. THE SHORTLIST MUST BE VARIED. The ${perCategory} entries within one category must be about ${perCategory} DIFFERENT subjects. Never shortlist two versions of the same story from two outlets, and never fill a category with facets of one big event — that wastes the choice the next step is supposed to make.
3. VARY THE ANGLE. Deliberately mix what kind of story you shortlist: not only the top political fight, not only the stock index, not only the newest AI model. Consumer, regional, cultural, scientific, labour, infrastructure and everyday-life angles all count and are usually MORE interesting to a learner than the day's biggest headline. Aim for a mix within every category.
4. VARY THE OUTLET. Prefer a spread of sources across the shortlist, and favour outlets that do not appear in the recent history.
5. REAL AND SUBSTANTIAL. Prefer stories with enough substance for a 300-word retelling. Avoid live tickers, liveblogs, photo galleries, opinion columns, podcasts, videos and pure listicles — they scrape badly and read badly.

If a category has fewer than ${perCategory} usable headlines, shortlist as many as it genuinely has. Never invent an id that is not on the slate above, and never repeat an id.

For each category return:
- category: the category name
- ids: an array of the numbers in square brackets of the headlines you shortlisted, BEST FIRST, at most ${perCategory} of them.

Respond with ONLY a JSON object, no other text and no markdown code fences:

{ "shortlists": [ { "category": "politics", "ids": [3, 11, 0, 7, 19, 2] } ] }`;
}

/**
 * Draw up a ranked shortlist of `perCategory` headlines for every category, in
 * a single call. These are the pages Firecrawl will actually fetch, so the
 * caller decides how many it can afford before calling this.
 *
 * A category the model skips, or answers with ids we can't use, is topped up
 * with the freshest unused headlines, and a call that fails outright falls back
 * to the freshest headlines everywhere — a bad answer costs ranking quality,
 * never a category and never the run.
 */
export async function shortlistHeadlines(
  client: OpenAI,
  today: string,
  candidates: Record<Category, Headline[]>,
  recentTopics: RecentTopic[],
  perCategory: number,
  timeoutMs: number,
): Promise<{ shortlist: CategoryShortlist[]; usage: UsageLite }> {
  const available = CATEGORY_ORDER.filter((c) => candidates[c]?.length);
  if (available.length === 0) {
    throw new Error('No headlines were collected from any feed — cannot select any stories.');
  }

  const wanted = Math.max(1, Math.floor(perCategory));
  const usage = emptyUsage();
  const idsByCategory = new Map<Category, number[]>();

  // This call is no longer the one step a run cannot survive losing. Ranking
  // headlines is a nice-to-have on top of "fetch the freshest few and read
  // them" — the choice step still makes a real decision, on the article text,
  // which is the better signal anyway. So a failure here costs diversity, not
  // the briefing.
  try {
    const prompt = buildShortlistPrompt(today, candidates, recentTopics, wanted);
    const result = await callModel(
      client,
      prompt,
      SELECT_MAX_OUTPUT_TOKENS,
      timeoutMs,
      'headline shortlist',
    );
    addUsage(usage, result.usage);

    const parsed = JSON.parse(extractJson(result.text)) as { shortlists?: unknown; picks?: unknown };
    const rows = Array.isArray(parsed?.shortlists)
      ? parsed.shortlists
      : Array.isArray(parsed?.picks)
        ? parsed.picks
        : [];

    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const category = row.category as Category;
      if (!CATEGORY_ORDER.includes(category) || idsByCategory.has(category)) continue;
      // Tolerate a single `id` as well as the `ids` array we asked for.
      const source = Array.isArray(row.ids) ? row.ids : row.id !== undefined ? [row.id] : [];
      const ids = source.map((v) => Number(v)).filter((n) => Number.isInteger(n));
      idsByCategory.set(category, ids);
    }
  } catch (err) {
    console.warn(
      `[shortlist] falling back to the freshest headlines: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Never scrape the same page twice, and never run two categories on the same
  // article — a slate shared between categories (tagesschau feeds both politics
  // and germany) makes both possible.
  const usedUrls = new Set<string>();
  const shortlist: CategoryShortlist[] = [];

  for (const category of available) {
    const list = candidates[category];
    const ids = idsByCategory.get(category) ?? [];
    const chosen: Headline[] = [];

    for (const id of ids) {
      if (chosen.length >= wanted) break;
      const headline = id >= 0 && id < list.length ? list[id] : undefined;
      if (!headline || usedUrls.has(headline.url)) continue;
      usedUrls.add(headline.url);
      chosen.push(headline);
    }

    // Top up from the freshest headlines the model didn't rank, so a thin or
    // malformed answer still gives the choice step something to compare.
    if (chosen.length < wanted) {
      for (const headline of list) {
        if (chosen.length >= wanted) break;
        if (usedUrls.has(headline.url)) continue;
        usedUrls.add(headline.url);
        chosen.push(headline);
      }
      if (ids.length === 0) {
        console.warn(`[shortlist] ${category}: no usable ids from the model — using the freshest headlines.`);
      }
    }

    if (chosen.length === 0) {
      console.warn(`[shortlist] ${category}: no usable headline left on the slate.`);
      continue;
    }

    shortlist.push({
      category,
      candidates: chosen.map((headline) => ({
        category,
        headline,
        topic_tag: headline.title.slice(0, 60),
        reason: '',
      })),
    });
    console.log(
      `[shortlist] ${category}: ${chosen.length} candidate(s) — ${chosen
        .map((h) => `"${h.title}" (${h.source})`)
        .join('; ')}`,
    );
  }

  if (shortlist.length === 0) {
    throw new Error('The shortlist step produced no usable headlines.');
  }
  return { shortlist, usage };
}

// ===========================================================================
// STEP 2 — CHOICE
// ===========================================================================
//
// The shortlist was ranked on headlines alone, which is a weak signal: a
// promising headline routinely turns out to be a two-paragraph agency snippet,
// a liveblog, or a paywall teaser. Now that the text of every shortlisted
// article is in hand, pick the one per category that will genuinely make the
// best briefing piece — one call for all five categories, so it can also keep
// the day's five stories from converging on the same event.

export function buildChoicePrompt(
  today: string,
  groups: CategoryCandidates[],
  recentTopics: RecentTopic[],
): string {
  const blocks = groups.map((group) => {
    const lines = group.candidates.map((candidate, i) => {
      const { headline } = candidate.selection;
      const when = headline.publishedAt ? headline.publishedAt.slice(0, 10) : 'undated';
      const excerpt = (candidate.scraped?.markdown ?? '')
        .slice(0, CHOICE_EXCERPT_CHARS)
        .replace(/\s+/g, ' ')
        .trim();
      const length = candidate.scraped?.markdown.length ?? 0;
      return `  [${i}] (${headline.source}, ${when}, ${length} chars of text) ${headline.title}\n      TEXT: ${excerpt}`;
    });
    return `${group.category} (${CATEGORY_DESC[group.category]}):\n${lines.join('\n')}`;
  });

  const history = recentTopics.length
    ? recentTopics
        .map(
          (t) =>
            `  - ${t.briefing_date} [${t.category}] ${t.topic_tag ? `${t.topic_tag} — ` : ''}${t.title_de}`,
        )
        .join('\n')
    : '  (nothing yet — this is the first briefing)';

  return `You are the editor of a daily German news briefing for a language learner. Today is ${today}. The shortlisted articles have been fetched, and below is the beginning of each one's real text. Choose exactly ONE article per category to write about. You are not writing anything yet.

${blocks.join('\n\n')}

These are the stories the briefing ALREADY covered in the last ${TOPIC_HISTORY_DAYS} days:
${history}

Judge the articles on the TEXT, not on the headline — this is the whole point of having fetched them. Pick, per category, the one that will make the best 250-350 word German article for an adult B2 learner:

1. SUBSTANCE. The text must actually tell a story: a concrete event, real detail, names, numbers, causes, consequences. Reject anything that is a two-line agency snippet, a teaser for a paywalled piece, a liveblog or ticker, a photo gallery, a podcast or video description, a listicle, a product deal or an advertisement — however good the headline sounds.
2. IT MUST BE THE ARTICLE. If the text looks like navigation, a cookie notice, a newsletter pitch or a list of other headlines, that scrape failed; do not pick it.
3. INTEREST. Prefer the story a curious adult living in Germany would actually want to read and talk about — something concrete and human over a procedural update. Surprising, everyday, regional, scientific and cultural angles usually beat the day's most-covered headline.
4. SELF-CONTAINED. Prefer a story that can be understood without following a running saga, and that does not need background the text itself never gives.
5. NOT A REPEAT. Do not pick a story on a subject in the "already covered" list. If every option in a category repeats a recent subject, pick the one whose angle differs most and say so in your reason.
6. DIFFERENT FROM EACH OTHER. The stories you pick today must not all be facets of one big news event.

For each category return:
- category: the category name
- id: the number in square brackets of the article you chose
- topic_tag: a SHORT English label (2-5 words) for what the story is about, naming the central subject — e.g. "pension reform bill", "Bundesliga streaming rights", "drought in Brandenburg". This is stored and shown to you tomorrow as history, so make it specific enough to recognise a repeat.
- reason: one short English sentence on why this article beat the others in its category.

Respond with ONLY a JSON object, no other text and no markdown code fences:

{ "picks": [ { "category": "politics", "id": 0, "topic_tag": "...", "reason": "..." } ] }`;
}

/**
 * Pick the article to write for each category, from the text that was actually
 * fetched. Categories whose scrapes all failed keep their best-ranked candidate
 * and are written from the feed summary instead.
 *
 * Never throws on a bad answer: an unusable pick falls back to the highest
 * ranked candidate that scraped successfully.
 */
export async function chooseArticles(
  client: OpenAI,
  today: string,
  groups: CategoryCandidates[],
  recentTopics: RecentTopic[],
  timeoutMs: number,
): Promise<{ choices: Choice[]; usage: UsageLite }> {
  const usage = emptyUsage();
  if (groups.length === 0) return { choices: [], usage };

  // Only categories with a real scrape can be judged on their text; the rest
  // fall back below without costing anything.
  const judgeable = groups.filter((g) => g.candidates.some((c) => c.scraped));

  const picks = new Map<Category, { id: number; topic_tag: string; reason: string }>();
  if (judgeable.length > 0 && timeoutMs > 0) {
    try {
      const prompt = buildChoicePrompt(
        today,
        // Hide the candidates that failed to scrape: there is nothing to judge
        // them on, and their ids would only be a way for the model to pick one.
        judgeable.map((g) => ({ category: g.category, candidates: g.candidates.filter((c) => c.scraped) })),
        recentTopics,
      );
      const result = await callModel(
        client,
        prompt,
        CHOICE_MAX_OUTPUT_TOKENS,
        timeoutMs,
        'article choice',
      );
      addUsage(usage, result.usage);

      const parsed = JSON.parse(extractJson(result.text)) as { picks?: unknown };
      for (const raw of Array.isArray(parsed?.picks) ? parsed.picks : []) {
        const p = raw as Record<string, unknown>;
        const category = p.category as Category;
        if (!CATEGORY_ORDER.includes(category) || picks.has(category)) continue;
        const id = Number(p.id);
        if (!Number.isInteger(id)) continue;
        picks.set(category, {
          id,
          topic_tag: typeof p.topic_tag === 'string' ? p.topic_tag.trim() : '',
          reason: typeof p.reason === 'string' ? p.reason.trim() : '',
        });
      }
    } catch (err) {
      // The whole point of the shortlist is that we already hold usable text.
      // Losing the ranking call is a quality regression, not a failed run.
      console.warn(
        `[choose] falling back to the shortlist order: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const choices: Choice[] = [];
  for (const group of groups) {
    // The model saw only the candidates that scraped, so resolve its id against
    // that same filtered list.
    const scrapedOnly = group.candidates.filter((c) => c.scraped);
    const pick = picks.get(group.category);
    let chosen: ScrapedCandidate | undefined;

    if (pick && pick.id >= 0 && pick.id < scrapedOnly.length) {
      chosen = scrapedOnly[pick.id];
    } else {
      // No usable pick: take the best-ranked candidate that has text, or — when
      // every scrape for this category failed — the best-ranked one overall, to
      // be written from its feed summary.
      chosen = scrapedOnly[0] ?? group.candidates[0];
      if (chosen) {
        console.warn(
          `[choose] ${group.category}: unusable pick (${pick ? `id ${pick.id}` : 'no pick'}) — falling back to "${chosen.selection.headline.title}".`,
        );
      }
    }

    if (!chosen) continue;

    const selection: Selection = {
      ...chosen.selection,
      topic_tag: pick?.topic_tag || chosen.selection.topic_tag,
      reason: pick?.reason ?? '',
    };
    choices.push({ category: group.category, selection, scraped: chosen.scraped });
    console.log(
      `[choose] ${group.category}: "${selection.headline.title}" (${selection.headline.source})` +
        `${chosen.scraped ? '' : ' [no scraped text — writing from the feed summary]'} — ` +
        `${pick?.reason || 'fallback pick'}`,
    );
  }

  if (choices.length === 0) {
    throw new Error('The choice step produced no usable articles.');
  }
  return { choices, usage };
}

// ===========================================================================
// STEP 3 — WRITING
// ===========================================================================

// Round-robin the (already priority-sorted) vocabulary into N buckets so each
// article focuses on a different slice — spreading repetition across the list
// instead of every article grabbing the same few least-used words.
export function partition<T>(items: T[], buckets: number): T[][] {
  const out: T[][] = Array.from({ length: buckets }, () => []);
  items.forEach((item, i) => out[i % buckets].push(item));
  return out;
}

export function buildArticlePrompt(
  today: string,
  selection: Selection,
  scraped: ScrapedArticle | null,
  focusVocab: VocabRow[],
  allVocab: VocabRow[],
): string {
  const { category, headline } = selection;

  const focusSource = FOCUS_VOCAB_LIMIT > 0 ? focusVocab.slice(0, FOCUS_VOCAB_LIMIT) : focusVocab;
  const focus = focusSource.map((v) => ({ german: v.german_word, english: v.english_translation }));
  const knownSource = KNOWN_VOCAB_LIMIT > 0 ? allVocab.slice(0, KNOWN_VOCAB_LIMIT) : allVocab;
  const known = knownSource.map((v) => v.german_word);

  // Either the full scraped article, or — when Firecrawl couldn't reach it — the
  // feed's own summary. The instruction below changes accordingly: with only a
  // summary the model must stay strictly within it rather than filling gaps.
  const sourceBlock = scraped
    ? `Here is the full text of that article:

--- BEGIN SOURCE ---
${scraped.markdown}
--- END SOURCE ---`
    : `The full text could not be retrieved, so you have ONLY the headline and this short summary from the news feed:

--- BEGIN SOURCE ---
${headline.summary || headline.title}
--- END SOURCE ---

Because your source is this thin, write a SHORTER piece (150-220 words) that covers only what the headline and summary actually state. Do NOT add details, numbers, quotes, names, causes or consequences that are not present above — if you don't know something, leave it out.`;

  return `You are writing ONE article for a daily German news briefing for a language learner. Today's date is ${today}. The category is "${category}" (${CATEGORY_DESC[category]}).

The story has already been chosen for you. Do not look for another one, and do not write about anything else.

Headline: ${headline.title}
Source: ${headline.source}
URL: ${headline.url}

${sourceBlock}

Here are vocabulary words the learner is studying. Weave 2 to 3 of the "focus" words naturally into this article. The "known" list is only so you don't reintroduce those words as if they were new:
focus: ${JSON.stringify(focus, null, 2)}
known: ${JSON.stringify(known)}

Write the German article, so:
- Keep it SHORT: between 250 and 350 words (a quick read, not a long piece).
- Target roughly B2 level. German news is normally written above B2, so simplify only where the source runs harder than B2: break up long sentences, swap rare or heavily compound words for more common ones, and drop unnecessary jargon. Do NOT flatten it down to A2/B1 — keep it natural, adult German at a solid B2.
- Retell the same facts as a clean standalone piece in your own German words (not a copy of the source's sentences). It stays in German throughout.
- Work ONLY from the source text above. Never invent, guess, or add facts that are not in it.

VOCABULARY — this is the most important part of the task, so read it carefully.

Choose between ${FOOTNOTES_MIN} and ${FOOTNOTES_MAX} words or phrases to highlight. This is a strict budget, not a minimum to exceed: every slot must go to a word that is genuinely worth learning. Prioritise, in this order:
1. Everyday, reusable German words — nouns, verbs, adjectives and adverbs that a learner will meet again constantly outside the news. These should be the MAJORITY of your choices.
2. Separable verbs (trennbare Verben), which are especially useful. Include one or two whenever the text contains them.
3. Useful connectors and set phrases ("im Hinblick auf", "sich durchsetzen", "zunehmend").
4. Genuinely difficult or specialised words that the story unavoidably forced into the text. These are welcome, but only a few.

NEVER highlight or gloss any of the following. This rule has no exceptions:
- Names of people, companies, brands, products, parties, institutions, places or countries (Apple, Merz, Bundestag, Bayern, Nvidia, PlayStation).
- Acronyms and abbreviations (KI, DAX, EU, BIP, GmbH), even if a reader might not know them.
- Numbers, dates, currencies and units.
These teach the learner nothing about German, and a glossary full of them is the single biggest problem with the current briefing.

FORMAT of the highlighted words:
- Wrap each chosen word in double asterisks, at the FIRST place it appears, like **die Auswirkung**.
- Every noun MUST be written with its definite article, e.g. **die Auswirkung**, **der Zusammenhang**, **das Vorhaben** — never a bare noun. If including the article inside the asterisks reads awkwardly in the sentence, choose a sentence where it works, or pick a different word.
- Verbs, adjectives, adverbs and phrases are highlighted as they appear in the text.
- For a separable verb that appears SPLIT in the sentence (e.g. "nimmt ... teil"), highlight only the contiguous part you can wrap, and name the infinitive in the explanation, like: word "nimmt", explanation "von 'teilnehmen': bei etwas dabei sein".
- Highlight each word only the first time it appears.

For EVERY highlighted word add one entry to "footnotes" with a SHORT explanation written ONLY in German — a simple synonym or a brief German definition, never English and never a translation. The "word" field must be the EXACT text between the asterisks, without the asterisks. List the footnotes in the order the words first appear.

Produce:
- category: "${category}"
- title_en: an English version of the headline
- source_url: "${headline.url}"
- summary_en: a two to three sentence English summary of what the article covers
- title_de: a simple German title for your adaptation
- content_de: the German article described above, with the highlighted words wrapped in double asterisks
- footnotes: an array of objects, one per highlighted word, each { "word": "...", "explanation_de": "kurze deutsche Erklärung" }
- vocab_used: an array of the exact focus-list words/phrases you used in this article
- vocab_new: an array with the one brand new word/phrase you introduced, as an object with "german" and "english" keys. It must obey all the vocabulary rules above — a real German word, never a name or an acronym.

Respond with ONLY a JSON object with this exact shape, no other text, no markdown code fences:

{ "category": "${category}", "title_en": "...", "source_url": "...", "summary_en": "...", "title_de": "...", "content_de": "...", "footnotes": [{"word":"...","explanation_de":"..."}], "vocab_used": ["..."], "vocab_new": [{"german":"...","english":"..."}] }`;
}

// Coerce whatever the model returned into a well-formed GeneratedArticle, and
// enforce the vocabulary rules in code — see lib/vocab.ts for why the prompt
// alone isn't enough.
function coerceArticle(
  parsed: unknown,
  selection: Selection,
  scraped: ScrapedArticle | null,
): GeneratedArticle {
  const { category, headline } = selection;
  const obj = parsed as Record<string, unknown> | null;
  const raw =
    obj && Array.isArray(obj.articles)
      ? ((obj.articles[0] ?? {}) as Record<string, unknown>)
      : ((obj ?? {}) as Record<string, unknown>);

  const title_de = typeof raw.title_de === 'string' ? raw.title_de : '';
  let content_de = typeof raw.content_de === 'string' ? raw.content_de : '';
  if (!title_de || !content_de) {
    throw new Error(`Article for "${category}" was missing title_de or content_de.`);
  }

  // Drop footnotes for anything that isn't a word worth learning, and un-bold it
  // in the body so the reader isn't left with a highlight that has no entry.
  const rejected: string[] = [];
  const footnotes: Footnote[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.footnotes)) {
    for (const item of raw.footnotes) {
      const f = item as { word?: unknown; explanation_de?: unknown } | null;
      const word = typeof f?.word === 'string' ? f.word.trim() : '';
      const explanation_de = typeof f?.explanation_de === 'string' ? f.explanation_de.trim() : '';
      if (!word || !explanation_de || seen.has(word)) continue;
      const verdict = checkVocabWord(word);
      if (!verdict.ok) {
        rejected.push(`${word} (${verdict.reason})`);
        continue;
      }
      seen.add(word);
      footnotes.push({ word, explanation_de });
    }
  }

  // Remove the asterisks around any word we just rejected. buildFootnotes()
  // would otherwise render it bold with no number, which looks like a bug.
  for (const entry of rejected) {
    const word = entry.slice(0, entry.lastIndexOf(' ('));
    content_de = content_de.split(`**${word}**`).join(word);
  }
  if (rejected.length) {
    console.log(`[vocab] ${category}: dropped ${rejected.length} — ${rejected.join(', ')}`);
  }

  const vocab_new = Array.isArray(raw.vocab_new)
    ? raw.vocab_new
        .filter(
          (v): v is { german: string; english?: string } =>
            !!v && typeof (v as { german?: unknown }).german === 'string',
        )
        .filter((v) => {
          const verdict = checkVocabWord(v.german);
          if (!verdict.ok) {
            console.log(`[vocab] ${category}: rejected new word "${v.german}" (${verdict.reason})`);
          }
          return verdict.ok;
        })
        .map((v) => ({ german: v.german, english: typeof v.english === 'string' ? v.english : '' }))
    : [];

  return {
    category,
    title_en: typeof raw.title_en === 'string' ? raw.title_en : headline.title,
    // Always trust OUR url over the model's: it came from the feed, so it can't
    // be a hallucinated or mangled link.
    source_url: scraped?.url ?? headline.url,
    summary_en: typeof raw.summary_en === 'string' ? raw.summary_en : '',
    topic_tag: selection.topic_tag,
    title_de,
    content_de,
    footnotes,
    vocab_used: Array.isArray(raw.vocab_used)
      ? raw.vocab_used.filter((w): w is string => typeof w === 'string')
      : [],
    vocab_new,
  };
}

// A body far too short to be the requested piece means something went wrong
// (truncation, or the model refusing the source). The old "no article found"
// placeholder check is gone with web_search — the model is no longer in a
// position to come back empty-handed, because we hand it the article.
function tooShort(article: GeneratedArticle, hadScrape: boolean): boolean {
  // The feed-summary fallback deliberately asks for a shorter piece.
  const floor = hadScrape ? 600 : 300;
  return article.content_de.trim().length < floor;
}

async function writeArticleOnce(
  client: OpenAI,
  today: string,
  selection: Selection,
  scraped: ScrapedArticle | null,
  focusVocab: VocabRow[],
  allVocab: VocabRow[],
  timeoutMs: number,
): Promise<{ article: GeneratedArticle; usage: UsageLite }> {
  const prompt = buildArticlePrompt(today, selection, scraped, focusVocab, allVocab);
  const { text, usage } = await callModel(
    client,
    prompt,
    MAX_OUTPUT_TOKENS,
    timeoutMs,
    `"${selection.category}"`,
  );
  const article = coerceArticle(JSON.parse(extractJson(text)), selection, scraped);
  if (tooShort(article, Boolean(scraped))) {
    throw new Error(
      `Article for "${selection.category}" came back too short (${article.content_de.trim().length} chars).`,
    );
  }
  return { article, usage };
}

/**
 * Write one category's article, with a small deadline-aware retry for a fast
 * failure (bad JSON, a truncated response, a too-short body). The retry only
 * fires while there's real budget left, so a slow first attempt is never retried.
 */
export async function writeArticle(
  client: OpenAI,
  today: string,
  selection: Selection,
  scraped: ScrapedArticle | null,
  focusVocab: VocabRow[],
  allVocab: VocabRow[],
  deadline: number,
): Promise<{ article: GeneratedArticle; usage: UsageLite; attempts: number }> {
  let lastErr: unknown = new Error(`No attempt was made for "${selection.category}".`);
  const usage = emptyUsage();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) break;
    try {
      const result = await writeArticleOnce(
        client,
        today,
        selection,
        scraped,
        focusVocab,
        allVocab,
        Math.min(REQUEST_TIMEOUT_MS, remaining),
      );
      addUsage(usage, result.usage);
      return { article: result.article, usage, attempts: attempt };
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function logUsage(today: string, totals: UsageLite, calls: number, attempts: number): void {
  console.log(
    `[cost] briefing ${today}: model=${MODEL} calls=${calls} attempts=${attempts} ` +
      `input_tokens=${totals.input} (cached ${totals.cached}) output_tokens=${totals.output}`,
  );
}

export { addUsage };
