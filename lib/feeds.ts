import { CATEGORY_ORDER, type Category } from './types';
import { envNumberMin, envPositive } from './env';

// ---------------------------------------------------------------------------
// RSS headline collection — the first half of "pick a genuinely different story".
//
// This replaces the old approach, where each category was handed to the model
// with a `web_search` tool and a couple of `site:` filters. That was expensive
// (every retrieved page is billed back as input tokens) AND monotonous: with two
// outlets and a "find a current story" instruction, the model reliably landed on
// whatever each site was leading with — which is why Politik kept being about
// the chancellor and Finanzen kept being about the DAX.
//
// RSS fixes both. Feeds are free, instant, and give us a WIDE slate of real
// headlines (dozens per category) that the shortlist step can then choose from
// while actively avoiding what we already covered. Firecrawl is then spent on
// the shortlist it draws up — a handful of pages per category, from which the
// choice step picks the one actually worth writing about.
// ---------------------------------------------------------------------------

export interface FeedSource {
  /** Display name, used in logs and in the selection prompt. */
  name: string;
  /** Feed URL (RSS 2.0, RDF, or Atom — all three are handled by the parser). */
  url: string;
}

export interface Headline {
  category: Category;
  /** The outlet's display name, so the model can prefer a source it hasn't used. */
  source: string;
  title: string;
  url: string;
  /** The feed's own description/summary, plain text. Also the fallback body if a scrape fails. */
  summary: string;
  /** ISO timestamp, or null when the feed didn't give a parseable date. */
  publishedAt: string | null;
}

// Four to six established German outlets per category, deliberately spread
// across the editorial spectrum and across "hard news" vs. society/culture, so
// the shortlist step has genuinely different angles to choose between rather
// than five versions of the same lead story.
//
// A feed that 404s, times out, or returns junk is silently skipped — the slate
// is built from whatever responded. That means you can add or remove entries
// here freely without risking a failed run. Override any category without
// touching code via FEEDS_<CATEGORY>, a comma-separated list of feed URLs
// (e.g. FEEDS_GAMING="https://www.gamestar.de/news/rss/news.rss").
//
// Run `npm run check-feeds` to see which of these are currently responding and
// how many recent items each one yields.
export const CATEGORY_FEEDS: Record<Category, FeedSource[]> = {
  politics: [
    { name: 'tagesschau', url: 'https://www.tagesschau.de/inland/index~rss2.xml' },
    { name: 'Zeit Politik', url: 'https://newsfeed.zeit.de/politik/index' },
    { name: 'Spiegel Politik', url: 'https://www.spiegel.de/politik/index.rss' },
    { name: 'n-tv Politik', url: 'https://www.n-tv.de/politik/rss' },
    { name: 'Deutschlandfunk', url: 'https://www.deutschlandfunk.de/nachrichten-100-rss.xml' },
    { name: 'taz', url: 'https://taz.de/!p4608;rss/' },
  ],
  finance: [
    { name: 'tagesschau Wirtschaft', url: 'https://www.tagesschau.de/wirtschaft/index~rss2.xml' },
    { name: 'Spiegel Wirtschaft', url: 'https://www.spiegel.de/wirtschaft/index.rss' },
    { name: 'Handelsblatt', url: 'https://www.handelsblatt.com/contentexport/feed/wirtschaft' },
    { name: 'Zeit Wirtschaft', url: 'https://newsfeed.zeit.de/wirtschaft/index' },
    { name: 'n-tv Wirtschaft', url: 'https://www.n-tv.de/wirtschaft/rss' },
  ],
  technology: [
    { name: 'heise online', url: 'https://www.heise.de/rss/heise-atom.xml' },
    { name: 'Golem', url: 'https://rss.golem.de/rss.php?feed=RSS2.0' },
    { name: 't3n', url: 'https://t3n.de/rss.xml' },
    { name: 'Spiegel Netzwelt', url: 'https://www.spiegel.de/netzwelt/index.rss' },
    { name: 'Zeit Digital', url: 'https://newsfeed.zeit.de/digital/index' },
    { name: 'netzpolitik.org', url: 'https://netzpolitik.org/feed/' },
  ],
  gaming: [
    { name: 'GameStar', url: 'https://www.gamestar.de/news/rss/news.rss' },
    { name: 'GamePro', url: 'https://www.gamepro.de/rss/news.rss' },
    { name: 'PC Games', url: 'https://www.pcgames.de/feed.cfm?menu_alias=home' },
    { name: 'Eurogamer.de', url: 'https://www.eurogamer.de/feed' },
    { name: '4Players', url: 'https://www.4players.de/4players.php/rss/allgemein.rss' },
  ],
  germany: [
    { name: 'Spiegel Panorama', url: 'https://www.spiegel.de/panorama/index.rss' },
    { name: 'Zeit Gesellschaft', url: 'https://newsfeed.zeit.de/gesellschaft/index' },
    { name: 'tagesschau', url: 'https://www.tagesschau.de/inland/index~rss2.xml' },
    { name: 'Deutsche Welle', url: 'https://rss.dw.com/rdf/rss-de-ger' },
    { name: 'Spiegel Wissenschaft', url: 'https://www.spiegel.de/wissenschaft/index.rss' },
    { name: 'MDR', url: 'https://www.mdr.de/nachrichten/index-rss.xml' },
  ],
};

// How long to wait on a single feed. Feeds are fetched in parallel, so this is
// also roughly the worst case for the whole collection step.
const FEED_TIMEOUT_MS = envPositive('FEED_TIMEOUT_MS', 10_000);

// How many items to keep from any ONE feed. Without a cap a single prolific
// outlet (heise publishes dozens a day) would crowd out every other source and
// re-create exactly the monotony we're trying to fix.
const PER_FEED_LIMIT = envPositive('FEED_PER_SOURCE_LIMIT', 8);

// How many headlines to hand the shortlist step per category. Enough for a real
// choice, small enough that the prompt stays cheap.
const PER_CATEGORY_LIMIT = envPositive('FEED_PER_CATEGORY_LIMIT', 30);

// How old a headline may be. Matches the old OPENAI_RECENCY_DAYS default; items
// with no parseable date are kept (many feeds omit it) rather than discarded.
const RECENCY_DAYS = envNumberMin('FEED_RECENCY_DAYS', 3, 1);

// Feed sources for a category, overridable via FEEDS_<CATEGORY> (comma-separated
// URLs). An empty/whitespace override falls back to the built-in list.
export function feedsFor(category: Category): FeedSource[] {
  const override = process.env[`FEEDS_${category.toUpperCase()}`];
  if (override && override.trim()) {
    const urls = override.split(',').map((u) => u.trim()).filter(Boolean);
    if (urls.length) return urls.map((url) => ({ name: hostOf(url), url }));
  }
  return CATEGORY_FEEDS[category];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// --- XML helpers ------------------------------------------------------------
// Feeds are simple and extremely well-formed in practice, so a focused parser
// beats pulling in an XML dependency. Everything here is defensive: anything it
// can't understand becomes an empty string and the item is dropped upstream.

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', sbquo: '‚', lsquo: '‘', rsquo: '’',
  euro: '€', deg: '°',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

// Strip CDATA wrappers, drop any embedded markup, decode entities, collapse
// whitespace. Feed descriptions routinely contain HTML; we want plain text.
function cleanText(raw: string): string {
  let t = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  t = t.replace(/<[^>]*>/g, ' ');
  t = decodeEntities(t);
  return t.replace(/\s+/g, ' ').trim();
}

// First occurrence of <tag>…</tag> inside a block, namespace-tolerant
// (matches both `<pubDate>` and `<dc:date>` when asked for `date`).
function tagText(block: string, tag: string): string {
  const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9]+:)?${tag}>`, 'i');
  const m = re.exec(block);
  return m ? cleanText(m[1]) : '';
}

// The item's canonical link. RSS/RDF put it in <link>…</link>; Atom uses
// <link href="…" rel="alternate"/> with no text content, so try both.
function itemLink(block: string): string {
  const text = tagText(block, 'link');
  if (text && /^https?:\/\//i.test(text)) return text;

  // Atom: prefer rel="alternate" (or a link with no rel at all) over
  // rel="self"/"replies"/"enclosure", which don't point at the article.
  const hrefs = [...block.matchAll(/<link\b([^>]*)\/?>/gi)];
  for (const [, attrs] of hrefs) {
    const rel = /rel\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (rel && rel.toLowerCase() !== 'alternate') continue;
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1];
    if (href && /^https?:\/\//i.test(href)) return decodeEntities(href);
  }
  // Some RDF feeds only carry the URL as an attribute on the item element.
  const about = /<item\b[^>]*rdf:about\s*=\s*["']([^"']*)["']/i.exec(block)?.[1];
  return about && /^https?:\/\//i.test(about) ? decodeEntities(about) : '';
}

function itemDate(block: string): string | null {
  for (const tag of ['pubDate', 'published', 'updated', 'date']) {
    const raw = tagText(block, tag);
    if (!raw) continue;
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

// Split a feed body into its item/entry blocks. Handles RSS 2.0 and RDF
// (<item>) as well as Atom (<entry>).
function splitItems(xml: string): string[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  return blocks;
}

// Query strings on news URLs are almost always tracking parameters, and they
// make the same article look like two different ones when we dedupe. Strip them.
function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** Parse one feed body into headlines. Exported so the checker script can reuse it. */
export function parseFeed(xml: string, category: Category, source: string): Headline[] {
  const out: Headline[] = [];
  for (const block of splitItems(xml)) {
    const title = tagText(block, 'title');
    const url = itemLink(block);
    if (!title || !url) continue; // an item we can't use is simply skipped
    const summary =
      tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'content');
    out.push({
      category,
      source,
      title,
      url: canonicalUrl(url),
      // Feed descriptions are sometimes the whole article; cap them so a fallback
      // body (and the selection prompt) can't blow up in size.
      summary: summary.slice(0, 600),
      publishedAt: itemDate(block),
    });
  }
  return out;
}

/** Fetch and parse a single feed. Never throws — a bad feed yields []. */
export async function fetchFeed(feed: FeedSource, category: Category): Promise<Headline[]> {
  try {
    const res = await fetch(feed.url, {
      // A few German outlets reject requests without a UA; identify ourselves honestly.
      headers: {
        'user-agent': 'german-b2-briefing/1.0 (+https://github.com/HalabiDaniel/news-app)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[feeds] ${feed.name}: HTTP ${res.status}`);
      return [];
    }
    return parseFeed(await res.text(), category, feed.name);
  } catch (err) {
    console.warn(`[feeds] ${feed.name}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function isRecent(h: Headline, cutoff: number): boolean {
  // No date is not a reason to drop a story — plenty of feeds omit one.
  if (!h.publishedAt) return true;
  const t = Date.parse(h.publishedAt);
  return !Number.isFinite(t) || t >= cutoff;
}

// Interleave one item from each source in turn (round-robin) instead of
// concatenating whole feeds. Combined with the daily rotation below, this is
// what stops the same outlet from occupying the top of the slate every day —
// and the top of the slate is what the model's attention lands on first.
function interleave(groups: Headline[][], limit: number): Headline[] {
  const out: Headline[] = [];
  const seen = new Set<string>();
  const depth = Math.max(0, ...groups.map((g) => g.length));
  for (let i = 0; i < depth && out.length < limit; i++) {
    for (const group of groups) {
      if (out.length >= limit) break;
      const item = group[i];
      if (!item || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
    }
  }
  return out;
}

// Rotate which outlet leads the slate, keyed to the date. Two outlets covering
// the same story will phrase it differently, and whichever comes first has an
// edge — so over a week every source gets its turn at the front.
function rotate<T>(items: T[], by: number): T[] {
  if (items.length < 2) return items;
  const n = ((by % items.length) + items.length) % items.length;
  return [...items.slice(n), ...items.slice(0, n)];
}

// Day number since the epoch, used purely as the rotation offset.
function dayIndex(date: string): number {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : 0;
}

/**
 * Collect the candidate headlines for one category: every configured feed in
 * parallel, filtered to recent items, deduped, round-robined across sources, and
 * capped. Returns [] if every feed for the category failed.
 */
export async function collectCategoryHeadlines(
  category: Category,
  date: string,
): Promise<Headline[]> {
  const feeds = rotate(feedsFor(category), dayIndex(date));
  const cutoff = Date.now() - RECENCY_DAYS * 86_400_000;

  const results = await Promise.all(feeds.map((f) => fetchFeed(f, category)));
  const groups = results.map((items) =>
    items
      .filter((h) => isRecent(h, cutoff))
      // Newest first within a source, so the round-robin takes each outlet's
      // freshest story before its second-freshest.
      .sort((a, b) => (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0))
      .slice(0, PER_FEED_LIMIT),
  );

  return interleave(groups, PER_CATEGORY_LIMIT);
}

/** Collect headlines for every category at once. */
export async function collectAllHeadlines(
  date: string,
): Promise<Record<Category, Headline[]>> {
  const lists = await Promise.all(
    CATEGORY_ORDER.map((c) => collectCategoryHeadlines(c, date)),
  );
  const out = {} as Record<Category, Headline[]>;
  CATEGORY_ORDER.forEach((c, i) => {
    out[c] = lists[i];
    console.log(`[feeds] ${c}: ${lists[i].length} candidate headlines`);
  });
  return out;
}
