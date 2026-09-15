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
  page.tsx                            Heute — today's five articles
  archiv/page.tsx                     The index, by month, with titles
  archiv/[datum]/page.tsx             One past day, same reading view
  vokabeln/page.tsx                   Accumulated vocabulary, least-seen first
  einstellungen/page.tsx              Notifications, and the manual trigger
  layout.tsx, globals.css             Shell and the hand-written design system
  manifest.ts                         /manifest.webmanifest — standalone, for iOS push
  api/cron/daily-briefing/route.ts    On-demand run, gated by CRON_SECRET
  api/revalidate/route.ts             Cache refresh, pinged by the daily run
  api/push/{subscribe,unsubscribe,test}/route.ts   One device's registration
components/
  ArticleView.tsx   The article — tap a bold word, the explanation appears
  FootnoteSheet.tsx Bottom sheet on a phone, centred card on a desktop
  CategoryRail.tsx  Jump straight to a category
  BriefingEmptyState.tsx  "Not yet" vs "something broke" — the daily monitor
  SiteHeader.tsx    The standalone app's only navigation
  ManualTrigger.tsx "Generate now", off the reading surface
  PushToggle.tsx    Enable, test, disable — and every iOS rule, explained
  PushNudge.tsx     The single, dismissible offer above today's briefing
  ServiceWorker.tsx Registers /sw.js on every page
lib/
  briefing.ts      The pipeline, stage by stage
  feeds.ts         RSS feed map + hand-rolled parser (RSS 2.0 / RDF / Atom)
  firecrawl.ts     Scrapes shortlisted articles to markdown, fail-soft
  scrapeBudget.ts  The hard daily ceiling, compare-and-set in Postgres
  openai.ts        The three model steps: shortlist, choose, write
  vocab.ts         What counts as a word worth learning
  footnotes.ts     Pairs each highlighted word with its explanation
  push.ts          Web push — the step that replaced the email
  pushSubscription.ts  What guards a publicly reachable subscribe endpoint
  queries.ts       Site reads (errors swallowed so builds need no credentials)
public/
  sw.js            The service worker: show the notification, open the briefing
  icon-*.png       Home-screen icons (scripts/generate-icons.mjs draws them)
scripts/
  run-briefing.ts  What the scheduled job runs
  check-feeds.ts   Which feeds are responding right now
  check-models.ts  Which model ids this API key can actually use
  check-archive.ts Does the whole archive still render under the current UI?
supabase/schema.sql  Idempotent schema — safe to re-run in full
.docs/               The rebuild plan, phase by phase
```

## Running it locally

```bash
npm install
cp .env.example .env        # fill in the real values
npm run check-feeds         # are the feeds responding?
npm run check-models        # is OPENAI_MODEL usable on this key?
npm run check-archive       # does every past article still render here?
npm run briefing            # a real run (writes to the database)
npm run dev                 # the site on http://localhost:3000
```

`BRIEFING_DATE=2026-01-01 npm run briefing` writes to a specific date, which is
how you test without overwriting a real day. `--force` regenerates a date that
already completed, and `--no-push` leaves the phone alone while doing it — which
is what you want when you are re-running a day to fix the website rather than to
announce it.

## The daily run

`.github/workflows/daily-briefing.yml` *is* the scheduled job — it runs the
pipeline on an Actions runner and writes straight to Supabase. On a public repo
that runner is free and unmetered, which is the whole reason this repo is
public.

Two things about GitHub's scheduler are worth knowing before you debug a late
briefing:

- **It is best-effort and always UTC.** The cron is `23 3 * * *` — off the hour
  on purpose, because every `minute 0` schedule on the platform is queued at the
  same instant and the old `0 4 * * *` started four to five hours late every
  day. If a week of observed start times is still outside ~15 minutes, point a
  free external cron (cron-job.org, QStash) at the `workflow_dispatch` API and
  leave the schedule as a backstop; a duplicate run the same day is harmless,
  because `runBriefing` skips a date that is already `completed`. GitHub cron
  does not follow daylight saving: `23 3` is 05:23 Berlin in summer, 04:23 in
  winter.
- **Scheduled workflows are auto-disabled after 60 days of repo inactivity.**
  A public-repo rule, and the failure is silent. GitHub emails a warning first;
  an external `workflow_dispatch` trigger is never auto-disabled.

A variable saved in the GitHub UI does **not** reach the run on its own —
Actions only exposes what the workflow maps into `env:`. Anything added in
Settings must also be listed in that block, or the code falls back to its
built-in default and the difference is invisible until something fails.

## Notifications

The delivery mechanism is a web push notification to a PWA on the iPhone home
screen. iOS makes that narrower than it sounds, and every constraint below is
Apple's, not a choice:

- **iOS 16.4+, and Home Screen only.** Push is never offered to a site open in
  a Safari tab, which is why the app declares `display: standalone` and why the
  settings page shows *Teilen → Zum Home-Bildschirm* instead of a button that
  could not work.
- **The permission prompt happens once, ever.** It must come from a real tap
  (asking on page load is silently ignored), and a denial is permanent — the
  only recovery is deleting the home-screen app and adding it again.
- **Subscriptions expire silently.** There is no event. The server only learns
  a device is gone by being told `404`/`410` on a send, which deletes the row.
  This is what the test button is for.

### Adding a device

In this order — each step fails differently, and doing them out of order looks
like a bug:

1. Open the site **in Safari on the iPhone** (not Chrome, not a in-app browser).
2. Share → **Add to Home Screen**. Close Safari.
3. Open the app **from the home screen**. No browser chrome means standalone.
4. Einstellungen → **Benachrichtigungen aktivieren** → grant. If a push
   passphrase is configured, it is asked for here, once per device.
5. **Test-Benachrichtigung.** It should arrive within seconds. If it doesn't,
   stop: nothing downstream will work either.

Re-do this after any change of origin. A home-screen app is pinned to the URL
it was installed from, and moving domains costs you the install and every push
subscription on it.

### When no notification arrives

Three checks, in this order, because each rules out a different layer:

1. **Open the app.** The empty state on *Heute* reads `briefing_runs` and says
   whether today's run is under way, failed (with the error), or never started.
   If there is no briefing, the notification was correct to stay quiet.
2. **Check `push_sent`** on that day's `briefing_runs` row. `0` means there were
   no live subscriptions; `1` means it was sent and lost downstream — an iOS
   Focus mode, or notifications switched off for the app in iOS Settings.
3. **Send a test push** from Einstellungen. If it reports the subscription
   expired, the row has already been deleted — just enable it again.

### VAPID keys

Generate once with `npx web-push generate-vapid-keys`:

| Key | Where it goes |
|---|---|
| Public | `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PUBLIC_KEY` in Vercel, `VAPID_PUBLIC_KEY` as an Actions secret |
| Private | `VAPID_PRIVATE_KEY` — an Actions secret (the daily run sends), **and** in Vercel, because the test button sends too |
| Subject | `VAPID_SUBJECT`, a `mailto:` or https URL. Required by the spec |

The public key reaching the browser is by design. Two things to know:

- **Regenerating the pair invalidates every subscription.** Every device must
  be re-subscribed by hand. Generate once, store carefully.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is **inlined at build time**, so setting it in
  Vercel only takes effect on the next deployment.

`PUSH_PASSPHRASE` is optional and recommended: `/api/push/subscribe` is
publicly reachable on a public site, and the passphrase closes it at the cost of
typing a word once per phone. Without it, the shape checks and the fifty-device
cap in `lib/pushSubscription.ts` are what stands there.

## Knowing when it breaks

1. GitHub → Settings → Notifications → Actions → "failed workflows only".
   Catches every failed run, but not a run that never started — including the
   silent one: **a scheduled workflow on a public repo is auto-disabled after
   60 days of repository inactivity.** GitHub emails a warning first; re-enable
   it in the Actions tab, or move the real trigger to an external cron hitting
   `workflow_dispatch`, which is never auto-disabled.
2. The site's empty state, which is the monitor you actually read. It reads
   `briefing_runs` for today and says which of three things is true: the run is
   under way, the run failed (with its error), or nothing started at all — plus
   the last successful date and how long ago it was. A disabled workflow and a
   crashed one look different here, which is the point.

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
- `/api/push/*` writes to the database on an unauthenticated POST. Three things
  stand there: the optional `PUSH_PASSPHRASE`, strict shape validation, and a
  fifty-row cap that turns unbounded growth into a contained failure. None of
  it is authentication, and it doesn't need to be — the worst a successful
  attacker achieves is receiving one German news notification per morning.
- `sw.js` caches nothing, deliberately. A service worker that caches HTML is
  the classic way to serve yesterday's briefing forever.

## Cutover from the old app

Both apps read and write the **same Supabase project**, so there is nothing to
migrate — and nothing to stop them both generating, which is why the first step
is disabling the old workflow rather than enabling this one. Run
`npm run check-archive` before switching: it walks the entire `articles` table
and reports anything the current UI cannot render, which is how you find out
that rows written before `topic_tag` and `footnotes` existed are still fine.

1. Disable the old **Daily Briefing** workflow (Actions → ⋯ → *Disable
   workflow*). Reversible in one click, which is the point.
2. Let this pipeline produce **seven consecutive good briefings**. Most of what
   goes wrong here is invisible on day one: the diversity check needs several
   days of history before it does anything, push subscriptions expire quietly,
   and the scheduler's real start time only shows up over a week.
3. Leave the old deployment serving and the old email path available as a
   fallback for as long as the old repo exists. Once it is gone, push is the
   only delivery mechanism there is.
4. **Copy across any tuning overrides** from the old repo's Settings → Secrets
   and variables → Variables *before* retiring it. Anything not carried over
   reverts to a built-in default silently, and a variable must also be mapped
   into the workflow's `env:` block to reach the run at all.
5. Point the URL at this app, re-install the PWA from the final URL, grant
   notifications, send a test push, and confirm the next scheduled run notifies
   *that* install. Every future origin change costs the home-screen app and
   every subscription on it, so if the URL is ever going to change, change it
   now.
6. Then decommission: delete or pause the old Vercel project, revoke the Resend
   API key, drop `RESEND_API_KEY` / `RESEND_FROM_EMAIL` / `RECIPIENT_EMAIL`, and
   **archive** the old repo rather than deleting it — the PR discussions explain
   several non-obvious constants, and archiving is reversible.

`.docs/06-cutover.md` has the full checklist.

## Licence

MIT — see [LICENSE](LICENSE).
