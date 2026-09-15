# Rebuild plan — overview

A rebuild of the daily German B2 briefing as a **public** repo and a
**web-only** app. The news pipeline is carried over as-is. Email goes away and
is replaced by a home-screen PWA with push notifications.

Phases:

| # | File | What it delivers |
|---|------|------------------|
| 1 | [`01-foundations.md`](01-foundations.md) | New public repo, Next.js scaffold, database, env plumbing |
| 2 | [`02-pipeline.md`](02-pipeline.md) | The retrieval + generation pipeline, ported verbatim, email removed |
| 3 | [`03-scheduling.md`](03-scheduling.md) | The daily run: free minutes, and actually on time |
| 4 | [`04-ui.md`](04-ui.md) | The new reading UI — the only delivery surface now |
| 5 | [`05-pwa-push.md`](05-pwa-push.md) | Manifest, service worker, iOS web push |
| 6 | [`06-cutover.md`](06-cutover.md) | Deploy, migrate, decommission the old repo |

Phases 1–3 restore a working daily briefing. Phases 4–5 are what makes the
website good enough to replace the email. Phase 6 retires the old setup.

---

## Why we're doing this

### What actually broke

The scheduled run has failed every day since 13 September. It is not a code
failure:

- Run 65 (15 Sep) created a job at `09:02:39Z` and marked it `failure` at
  `09:02:41Z` — **two seconds**, with no steps executed.
- The job log endpoint returns **404**, i.e. no log was ever produced.

A job that fails before its first step and writes no log never got a runner.
That is an account-level block — a spending limit or a failed payment — not
something in this repository. Runs 56–62 on the identical commit all succeeded,
so nothing in the code changed underneath it.

The repository is **private**, so its Actions minutes are metered against the
2,000/month that GitHub Free includes. The exact reason is on the run page and
at <https://github.com/settings/billing>.

### The fix, and why it's a rebuild

Public repositories get **unlimited free Actions minutes** on standard runners.
That alone unblocks the daily run, permanently, at no cost.

Going public is safe here — verified, not assumed:

- No `.env` file has ever been committed (`git log --all --diff-filter=A`
  shows only `.env.example`).
- No secret-shaped string appears anywhere in the tracked tree or in history
  (scanned for `sk-*`, `re_*`, `fc-*`, `eyJhbGciOi…` JWTs).
- Every credential lives in Actions secrets and Vercel env vars, which are not
  part of the repository and are not exposed by making it public.

So the rebuild isn't required by the billing problem. It's the opportunity to
do the two things we actually want — a proper reading UI and push instead of
email — on a clean, public repo with unlimited CI.

### A second problem worth fixing while we're here

The cron is `0 4 * * *` (06:00 Berlin). The last ten runs actually started at
08:11–09:21 UTC — consistently **4 to 5 hours late**. The "morning" briefing
has been landing mid-morning, every day. GitHub deprioritises scheduled
workflows, and on-the-hour schedules are the most congested slot.
Phase 3 addresses this directly.

---

## What stays exactly the same

> **This is the most important constraint in the plan.** The pipeline is the
> product. It has been tuned over ~10 PRs to solve real, specific failures:
> every Politik piece being about the chancellor, every Finanzen piece about the
> DAX, "KI" and "Apple" being saved as vocabulary, paywall teasers being written
> up as scoops. That tuning lives in prompt wording and in threshold constants.
> **Copy these files. Do not rewrite, "clean up", or re-derive them.**

Carried over byte-for-byte:

| File | What it holds |
|------|---------------|
| `lib/feeds.ts` | 28 German RSS feeds, the hand-rolled XML parser, round-robin interleave + daily source rotation |
| `lib/firecrawl.ts` | Scrape-to-markdown, fail-soft everywhere, concurrency and deadline handling |
| `lib/scrapeBudget.ts` | The 30/day Firecrawl ceiling, compare-and-set in Postgres so it holds across runs |
| `lib/openai.ts` | All three prompts (shortlist / choose / write) + validation. 873 lines of accumulated tuning |
| `lib/vocab.ts` | The "is this worth learning" filter — the German-capitalisation-plus-article trick |
| `lib/footnotes.ts` | Text-driven footnote numbering |
| `lib/env.ts` | Blank-means-unset handling for both Actions and Vercel |
| `lib/dates.ts` | Europe/Berlin date handling |
| `lib/types.ts` | Categories, row shapes |

Also unchanged: the six-stage shape of the run (RSS → shortlist → scrape →
choose → write → persist), the five categories, the Supabase schema for
`articles` / `vocabulary` / `scrape_budget`, and the 30-scrapes-per-day cap.

## What changes

| | Old | New |
|---|---|---|
| Repo | private | public |
| Delivery | Resend email + website | website only, push notification as the ping |
| Reading surface | email client | home-screen PWA on iPhone |
| Footnotes | numbered list at the end of the article | tap the word, read it in place |
| `lib/email.ts`, `resend` dep | present | deleted |
| `briefing_runs.email_sent` | boolean | replaced by `push_sent` |
| CI cost | metered, currently blocked | free and unlimited |

## What we are deliberately not changing

- **Supabase project.** Reuse the existing one. The article and vocabulary
  history is worth keeping and a new project buys nothing. Phase 1 adds tables;
  it does not migrate data.
- **Hosting.** Vercel, Hobby tier. The 60s function ceiling is irrelevant now —
  the pipeline runs in Actions, and the site only does reads.
- **OpenAI / Firecrawl accounts.** Same keys, same spend.

## Architecture after the rebuild

```
                     GitHub Actions (public repo, free, unlimited)
                     ┌──────────────────────────────────────────┐
  28 RSS feeds ─────▶│ 1 collect   free, parallel, ~30/category  │
                     │ 2 shortlist 1 model call, all categories  │
  Firecrawl ────────▶│ 3 scrape    ≤30 pages/day, DB-enforced    │
                     │ 4 choose    1 model call, over real text  │
  OpenAI ───────────▶│ 5 write     1 call per category           │
                     │ 6 persist   articles + vocabulary         │
                     │ 7 notify    web-push to every subscriber  │  ← new
                     └───────────────────┬──────────────────────┘
                                         │
                              Supabase (unchanged schema + 1 new table)
                                         │
                                  Vercel / Next.js
                                         │
                              iPhone home-screen PWA
```

Step 7 replaces the email send. Everything above it is the code we already have.

## Decisions already made

1. **Public repo.** Unlimited Actions minutes. History verified clean.
2. **No email.** Resend removed entirely, not flag-gated. Accepted trade-off:
   if an iOS push subscription dies silently there is no fallback ping — the
   briefing is still on the website, and Phase 5 includes a test-push button to
   check the subscription is alive.
3. **Same Supabase project**, so history survives with no migration.
4. **Push is sent from the Actions run**, not from Vercel — it's the process
   that knows the articles landed.

## Open questions to settle before Phase 4

- **Repo and app name.** New public repo needs a name; `german-articles` is
  taken by the old one. The Vercel URL changes with it.
- **Visual direction for the UI.** Phase 4 proposes one; it's a starting point,
  not a spec.
- **Notification time.** Currently targeting 06:00 Berlin. Worth confirming
  that's when you want the phone to buzz.
