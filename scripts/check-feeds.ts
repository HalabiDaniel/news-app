/**
 * Check every configured RSS feed and report what it returns.
 *
 * Feeds move and outlets retire them, and a dead feed fails silently by design
 * (the run just uses whatever responded). This is how you notice — run it after
 * editing CATEGORY_FEEDS, or whenever a category starts feeling thin:
 *
 *   npm run check-feeds
 */
import { CATEGORY_ORDER } from '../lib/types';
import { fetchFeed, feedsFor } from '../lib/feeds';

async function main(): Promise<void> {
  let dead = 0;
  let total = 0;

  for (const category of CATEGORY_ORDER) {
    console.log(`\n${category}`);
    const feeds = feedsFor(category);
    const results = await Promise.all(feeds.map((f) => fetchFeed(f, category)));
    feeds.forEach((feed, i) => {
      total++;
      const items = results[i];
      const ok = items.length > 0;
      if (!ok) dead++;
      const newest = items[0]?.publishedAt?.slice(0, 10) ?? '—';
      console.log(
        `  ${ok ? '✅' : '❌'} ${feed.name.padEnd(22)} ${String(items.length).padStart(3)} items  newest ${newest}  ${feed.url}`,
      );
    });
  }

  console.log(`\n${total - dead}/${total} feeds responding.`);
  if (dead > 0) {
    console.log('Replace or remove the failing feeds in CATEGORY_FEEDS (lib/feeds.ts).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
