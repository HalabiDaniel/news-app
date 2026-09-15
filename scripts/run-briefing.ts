/**
 * The scheduled daily run, as a plain Node script.
 *
 * Why not the Vercel cron any more: the pipeline is now six stages deep (RSS →
 * shortlist → scrape the shortlist → choose → write → deliver) instead of one
 * model call per category, and that does not reliably fit the 60s Hobby function
 * ceiling. A run that overshoots there returns a 504 with nothing saved — no
 * website update, no notification. A GitHub Actions job has no such limit, costs
 * nothing, and can take its time — which matters most for the scrape stage,
 * where up to 30 pages are fetched four at a time.
 *
 * Run locally with:  npm run briefing
 * Force a re-run:    npm run briefing -- --force
 * Website only:      npm run briefing -- --force --no-push
 *
 * `--no-push` is for re-running a day to fix the website without buzzing the
 * phone a second time. The push is the only part of this script that reaches
 * outside; everything else is safe to repeat.
 */
import { runBriefing } from '../lib/briefing';
import { berlinDateString } from '../lib/dates';
import { recordPushCount, sendBriefingPush } from '../lib/push';

// Ask the deployed site to drop its cached pages once the articles are in, so
// the website updates before the notification goes out instead of up to five
// minutes later. With the email gone this is load-bearing rather than merely
// tidy: the push is only a ping, so the article has to be there the moment it
// is tapped. Optional: without SITE_URL the pages just refresh on their own.
async function revalidateSite(date: string): Promise<void> {
  const siteUrl = process.env.SITE_URL;
  const secret = process.env.CRON_SECRET;
  if (!siteUrl || !secret) {
    console.log('[revalidate] SITE_URL or CRON_SECRET not set — skipping the cache ping.');
    return;
  }
  try {
    const res = await fetch(`${siteUrl.replace(/\/$/, '')}/api/revalidate?date=${date}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`[revalidate] ${res.status} ${res.ok ? 'ok' : await res.text()}`);
  } catch (err) {
    // A failed cache ping is cosmetic — ISR will catch up within five minutes.
    console.warn(`[revalidate] ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const skipPush = process.argv.includes('--no-push');
  const date = process.env.BRIEFING_DATE || berlinDateString();

  console.log(`[briefing] starting run for ${date}${force ? ' (forced)' : ''}`);
  const started = Date.now();

  const result = await runBriefing({ date, force, onPersisted: revalidateSite });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.skipped) {
    console.log(`[briefing] ${date}: already completed, nothing to do (${seconds}s).`);
    return;
  }

  console.log(`[briefing] ${date}: wrote ${result.articles} article(s) in ${seconds}s.`);

  if (skipPush) {
    console.log('[push] --no-push: the website is updated, the phone is not.');
  } else {
    // Notify last, and never let it fail the run: the briefing is already
    // written and live on the website, which is the part that matters.
    try {
      const sent = await sendBriefingPush(date, result.articles);
      await recordPushCount(date, sent);
      console.log(`[push] notified ${sent} device(s).`);
    } catch (err) {
      console.warn(`[push] notification step failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (result.errors.length) {
    // A partial run still delivered a briefing, so don't fail the workflow — but
    // make the failures loud enough to notice in the Actions log.
    console.warn(`[briefing] ${result.errors.length} category/categories failed:`);
    for (const e of result.errors) console.warn(`  - ${e}`);
  }
}

main().catch((err) => {
  console.error(`[briefing] run failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
