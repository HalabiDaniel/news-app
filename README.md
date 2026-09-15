# Daily German B2 News Briefing

Every morning this app collects German news from ~28 RSS feeds across five
categories (Politik, Finanzen, Technologie, Gaming, Deutschland), picks one
story per category, and writes each as a short English summary plus a **short
German article** simplified to roughly CEFR B2 (~250–350 words). Each article
glosses 8–12 words worth learning, and those words are tracked so they repeat
across days for spaced repetition.

Everything is stored in Postgres and read from the website. There is no email:
the ping is a **web push notification** to a home-screen PWA.

## How a day runs

```
GitHub Actions (public repo → free, unlimited minutes)
  1 collect    28 RSS feeds, free and parallel, ~30 headlines per category
  2 shortlist  one model call, ranks headlines against the last week's topics
  3 scrape     Firecrawl fetches the shortlist, hard-capped at 30 pages/day
  4 choose     one model call, over the real article text
  5 write      one call per category
  6 persist    articles + vocabulary, then refresh the site's cache
  7 notify     web push to every stored subscription
        │
   Supabase ──→ Vercel / Next.js ──→ iPhone home-screen PWA
```

Step 6 refreshes the site *before* step 7 fires: the notification is only a
ping, so the article has to be there the moment it's tapped.

## Project layout

```
app/
  layout.tsx, page.tsx, globals.css   The site (Phase 1 placeholder for now)
  api/cron/daily-briefing/route.ts    On-demand run, gated by CRON_SECRET
  api/revalidate/route.ts             Cache refresh, pinged by the daily run
lib/
  briefing.ts      The pipeline, stage by stage
  feeds.ts         RSS feed map + hand-rolled parser (RSS 2.0 / RDF / Atom)
  firecrawl.ts     Scrapes shortlisted articles to markdown, fail-soft
  scrapeBudget.ts  The hard daily ceiling, compare-and-set in Postgres
  openai.ts        The three model steps: shortlist, choose, write
  vocab.ts         What counts as a word worth learning
  footnotes.ts     Pairs each highlighted word with its explanation
  push.ts          Web push — the step that replaced the email
  queries.ts       Site reads (errors swallowed so builds need no credentials)
scripts/
  run-briefing.ts  What the scheduled job runs
  check-feeds.ts   Which feeds are responding right now
  check-models.ts  Which model ids this API key can actually use
supabase/schema.sql  Idempotent schema — safe to re-run in full
.docs/               The rebuild plan, phase by phase
```

## Running it locally

```bash
npm install
cp .env.example .env        # fill in the real values
npm run check-feeds         # are the feeds responding?
npm run check-models        # is OPENAI_MODEL usable on this key?
npm run briefing            # a real run (writes to the database)
npm run dev                 # the site on http://localhost:3000
```

`BRIEFING_DATE=2026-01-01 npm run briefing` writes to a specific date, which is
how you test without overwriting a real day. `--force` regenerates a date that
already completed.

## Costs

The expensive `web_search` tool is gone — the model reads the pages Firecrawl
fetched for it. What's left is ordinary tokens on a small model, plus at most
30 Firecrawl scrapes a day (~900/month). The scrape ceiling lives in the
database, not in memory, so the scheduled run, the manual trigger and a local
forced run share one budget instead of each spending a full day's worth.

## Security notes for a public repo

- No secrets in CI: `.github/workflows/ci.yml` runs fork PR code and is given
  none. **Never** add `pull_request_target` to a workflow in this repo.
- The daily job triggers on `schedule` and `workflow_dispatch` only.
- `CRON_SECRET` guards a publicly reachable endpoint — use 32+ random bytes.
  The real backstop is still the daily scrape budget: even a leaked secret buys
  an attacker 30 scrapes a day, not unlimited spend.
- `push_subscriptions` has RLS enabled with no policies; it is written
  server-side with the service role key only.

## Licence

MIT — see [LICENSE](LICENSE).
