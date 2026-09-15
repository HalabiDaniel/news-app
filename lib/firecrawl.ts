// ---------------------------------------------------------------------------
// Firecrawl — turn candidate article URLs into clean markdown.
//
// This is the only paid scraping in the pipeline. Headlines come from RSS (free),
// so Firecrawl is spent on the shortlist the selection step drew up: 4-6 pages
// per category, from which the next step picks the one actually worth writing
// about. A headline plus a two-line blurb is a poor basis for that judgement;
// the article text is a good one.
//
// That is up to 30 pages a day, so the count is capped — see lib/scrapeBudget.ts
// for the daily ceiling, which is claimed BEFORE anything here is called. This
// module never decides how much to spend; it only spends what it is handed.
//
// Everything here fails SOFT: no key, a timeout, a paywall, an exhausted credit
// balance — all return null, and the caller falls back to another candidate or
// to writing from the feed summary. A scrape problem must never cost a category.
// ---------------------------------------------------------------------------

import { envNumberMin, envPositive, envString } from './env';

const API_BASE = envString('FIRECRAWL_API_URL') ?? 'https://api.firecrawl.dev';
const API_VERSION = envString('FIRECRAWL_API_VERSION') ?? 'v2';

// A single scrape is normally a few seconds. The ceiling matters because the
// Vercel manual-trigger path still has a 60s budget to respect; the GitHub
// Actions path has no such limit and can afford to be patient.
const SCRAPE_TIMEOUT_MS = envPositive('FIRECRAWL_TIMEOUT_MS', 25_000);

// Cap what we hand to the model. A long feature can run to 10k+ tokens of
// markdown, and we only need enough to retell the story faithfully — the rest is
// input cost for no benefit. ~12k characters is roughly 3-4k tokens.
const MAX_MARKDOWN_CHARS = envPositive('FIRECRAWL_MAX_CHARS', 12_000);

// Below this, whatever came back is a cookie banner, a paywall interstitial, or
// a nav shell rather than an article — treat it as a failed scrape so the caller
// falls back to the feed summary instead of writing from navigation links.
const MIN_USABLE_CHARS = envNumberMin('FIRECRAWL_MIN_CHARS', 400, 0);

// How many pages to fetch at once. The shortlist is up to 30 URLs, and firing
// all of them off together is the quickest way to collect a 429 from Firecrawl
// (and to be rude to five news sites at the same time). Four in flight keeps a
// full 30-page batch under a minute while staying well inside the rate limits
// of the cheap tiers.
const SCRAPE_CONCURRENCY = envNumberMin('FIRECRAWL_CONCURRENCY', 4, 1);

// Don't start a scrape that the run's deadline can't possibly wait for — better
// to leave the credit unspent and hand it back than to pay for a fetch whose
// result arrives after everything downstream has given up.
const SCRAPE_HEADROOM_MS = 5_000;

export interface ScrapedArticle {
  url: string;
  /** The article body as markdown, trimmed to MAX_MARKDOWN_CHARS. */
  markdown: string;
  /** The page's own title, when Firecrawl could extract one. */
  title: string | null;
}

export function firecrawlConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY);
}

// Markdown from a news page still carries a lot that isn't the article: image
// credits, "Mehr zum Thema" link lists, share buttons, newsletter pitches. Strip
// the cheap, obviously-safe cases so the model's input is mostly prose.
function tidyMarkdown(md: string): string {
  return md
    // Images and figure markup contribute nothing to a text retelling.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Collapse [text](url) to just text: link targets are pure token cost here.
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')
    // Runs of blank lines left behind by the removals above.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Scrape one URL to markdown. Returns null on ANY failure (missing key, HTTP
 * error, timeout, empty/too-short body) — never throws, so a caller can simply
 * fall back to the RSS summary.
 */
export async function scrapeArticle(url: string): Promise<ScrapedArticle | null> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    console.warn('[firecrawl] FIRECRAWL_API_KEY is not set — falling back to feed summaries.');
    return null;
  }

  try {
    const res = await fetch(`${API_BASE}/${API_VERSION}/scrape`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        // Ask Firecrawl for the article body rather than the whole page chrome.
        onlyMainContent: true,
        // Firecrawl's own internal timeout, in ms. Keep it just under ours so a
        // slow page comes back as a clean error rather than an aborted socket.
        timeout: Math.max(5_000, SCRAPE_TIMEOUT_MS - 3_000),
      }),
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });

    if (!res.ok) {
      // 402 = out of credits, 429 = rate limited, 408 = the page never loaded.
      // All of them mean the same thing to us: use the fallback.
      const detail = await res.text().catch(() => '');
      console.warn(`[firecrawl] ${url}: HTTP ${res.status} ${detail.slice(0, 200)}`);
      return null;
    }

    const body = (await res.json()) as {
      success?: boolean;
      data?: { markdown?: string; metadata?: { title?: string } };
    };

    const markdown = tidyMarkdown(body?.data?.markdown ?? '');
    if (markdown.length < MIN_USABLE_CHARS) {
      console.warn(
        `[firecrawl] ${url}: only ${markdown.length} chars of usable text (paywall or blocked?).`,
      );
      return null;
    }

    return {
      url,
      markdown: markdown.slice(0, MAX_MARKDOWN_CHARS),
      title: body?.data?.metadata?.title ?? null,
    };
  } catch (err) {
    console.warn(`[firecrawl] ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export interface BatchScrapeResult {
  /** One entry per URL that was actually fetched: the article, or null on failure. */
  results: Map<string, ScrapedArticle | null>;
  /** How many fetches were attempted — i.e. how many credits were really spent. */
  attempted: number;
  /** URLs never fetched because the deadline ran out; their credits can go back. */
  skipped: string[];
}

/**
 * Scrape a list of URLs, at most SCRAPE_CONCURRENCY at a time.
 *
 * Duplicates are fetched once. Individual failures are not: every URL that was
 * attempted appears in `results`, mapped to null if it didn't come back usable.
 * If `deadline` is given, URLs that can no longer be started in time are left
 * unattempted and reported in `skipped` rather than being fetched too late.
 */
export async function scrapeArticles(
  urls: string[],
  options: { concurrency?: number; deadline?: number } = {},
): Promise<BatchScrapeResult> {
  const concurrency = Math.max(1, options.concurrency ?? SCRAPE_CONCURRENCY);
  const results = new Map<string, ScrapedArticle | null>();
  const skipped: string[] = [];
  let next = 0;
  let attempted = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= urls.length) return;
      const url = urls[index];
      if (results.has(url)) continue; // the same story on two categories' shortlists

      if (options.deadline !== undefined && Date.now() + SCRAPE_HEADROOM_MS > options.deadline) {
        skipped.push(url);
        continue;
      }

      // Reserve the slot before awaiting so a duplicate later in the list can't
      // start a second fetch of the same page while this one is in flight.
      results.set(url, null);
      attempted++;
      results.set(url, await scrapeArticle(url));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()),
  );

  const usable = [...results.values()].filter(Boolean).length;
  console.log(
    `[firecrawl] scraped ${usable}/${attempted} page(s) usefully` +
      (skipped.length ? `, ${skipped.length} skipped (out of time)` : '') +
      '.',
  );

  return { results, attempted, skipped };
}
