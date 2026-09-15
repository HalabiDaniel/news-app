# Phase 2 — The pipeline

Port the news pipeline into the new repo. This phase is mostly **copying
files**, and it is deliberately the least creative phase in the plan.

**Done when:** `npm run briefing` on the new repo produces five articles in the
database, identical in quality to the old app, with no email sent.

---

## 2.1 The rule for this phase

> Copy the files. Do not rewrite them.

Every one of these modules encodes a fix for something that actually went
wrong in production. Re-deriving them from scratch means re-discovering those
failures one morning at a time:

- **`lib/feeds.ts`** — the RSS layer replaced a `web_search` approach that was
  both expensive (every retrieved page billed back as input tokens) and
  monotonous. The round-robin interleave and the date-keyed source rotation
  exist because whichever outlet leads the slate gets the model's attention;
  without them Politik was about the chancellor every single day. The XML
  parser is hand-rolled on purpose and handles RSS 2.0, RDF and Atom.
- **`lib/openai.ts`** — three prompts, 873 lines. The split into
  shortlist/choose/write is what makes the diversity check possible at all:
  you cannot avoid yesterday's story if you never see the list of options. The
  choose step exists because a headline is a weak signal — plenty turn out to
  be liveblogs, agency snippets, or paywall teasers, and that's only visible
  once you can read the page.
- **`lib/vocab.ts`** — the filter that stops "KI", "Apple" and "DAX" being
  saved as vocabulary. The trick is that German capitalises common nouns, so
  capitalisation alone proves nothing — but the prompt requires nouns to come
  *with their article*, which turns "capitalised with no article" into a
  reliable proper-noun signal.
- **`lib/scrapeBudget.ts`** — the 30/day Firecrawl ceiling. It lives in
  Postgres with a compare-and-set rather than in memory because the scheduled
  run, the manual trigger, and a local `--force` are three separate processes
  that would otherwise each spend a full day's budget.
- **`lib/env.ts`** — blank-means-unset. Both GitHub Actions and Vercel hand you
  variables that are *present but empty*, and `Number('')` is `0`, which is
  finite. That's how a vocabulary limit silently became "send everything".

Copy verbatim, no edits:

```
lib/feeds.ts
lib/firecrawl.ts
lib/scrapeBudget.ts
lib/openai.ts
lib/vocab.ts
lib/footnotes.ts
lib/env.ts
lib/dates.ts
lib/types.ts
lib/supabaseAdmin.ts
lib/queries.ts
scripts/check-feeds.ts
scripts/check-models.ts
```

The only edit anywhere in that list is a comment: `lib/feeds.ts` sends a
`user-agent` naming the old repo URL. Update the URL, change nothing else.

## 2.2 `lib/briefing.ts` — the one file that changes

Copy it, then make exactly these edits:

**Remove the email step.** In stage 6:

```ts
// delete:
if (!options.skipEmail) {
  await sendBriefingEmail(today, articles);
}
```

**Replace the `skipEmail` option with `skipNotify`** in `RunOptions`, and leave
the hook empty for now — Phase 5 fills it in:

```ts
/** Skip the push notification (handy when re-running to fix the website only). */
skipNotify?: boolean;
```

**Update the run record.** `email_sent` becomes `push_sent`, written as a count
in Phase 5. Until then write `0`:

```ts
await supabase
  .from('briefing_runs')
  .update({ status: 'completed', push_sent: 0, error_message: null })
  .eq('briefing_date', today);
```

**Drop the `sendBriefingEmail` import.**

Everything else in the file — the six stages, the duplicate guard, the
rank-first credit spending in `scrapeShortlist`, the `Promise.allSettled` so a
failing category is dropped rather than fatal, `updateVocabulary` — stays.

Then **delete `lib/email.ts`** and remove `resend` from `package.json`.

`lib/footnotes.ts` stays even though the email is gone: `buildFootnotes` is
what pairs each `**bold**` word with its explanation and numbers them by order
of appearance in the text. Phase 4's tap-to-read footnotes need exactly that.

## 2.3 `scripts/run-briefing.ts`

Copy it. Two edits:

- Update the comment block — it explains why the run moved off Vercel cron,
  which is still true and still worth keeping, but it should describe the new
  repo.
- After `onPersisted`, add the notification step (Phase 5 implements
  `sendBriefingPush`; stub it here):

```ts
const result = await runBriefing({ date, force, onPersisted: revalidateSite });
// ... existing logging ...
if (!result.skipped) {
  const sent = await sendBriefingPush(date, result.articles);
  console.log(`[push] notified ${sent} device(s).`);
}
```

Keep `revalidateSite` exactly as it is. It's what makes the website update the
moment the run finishes instead of up to five minutes later — and with the
email gone, that latency is now the difference between the notification
arriving and the article being there when you tap it. **This gets more
important, not less.**

## 2.4 The manual-trigger route

Copy `app/api/cron/daily-briefing/route.ts` and `app/api/revalidate/route.ts`.

One thing to be aware of: **this site is now public.** The route is gated on
`CRON_SECRET` and returns 401 without it, which is the right protection, but
note what the real backstop is — the daily Firecrawl budget in
`scrape_budget`. Even if the secret leaked, an attacker gets 30 scrapes a day
across all callers, not unlimited spend. That design decision is now
load-bearing rather than merely tidy.

Two things to tighten while porting:

- Use a long random `CRON_SECRET` (32+ bytes). It was never in the repo, but it
  now guards a publicly-reachable endpoint.
- Keep the `?key=` query-string fallback if you use it from your phone, but
  know it ends up in logs. Prefer the header path.

The route keeps its tighter deadline (`BRIEFING_ROUTE_DEADLINE_MS`, 45s) and
its reduced shortlist (`BRIEFING_ROUTE_SCRAPES_PER_CATEGORY`, 2) because Vercel
Hobby still caps functions at 60s. Unchanged.

## 2.5 Verifying the port

The pipeline is non-deterministic, so "it ran" is not evidence it ported
correctly. Check the things that were actually hard to get right:

```bash
npm run check-feeds     # every feed responding, item counts look sane
npm run check-models    # OPENAI_MODEL is a model your key can use
npm run briefing        # a real run
```

Then look at the output and confirm:

- [ ] **Five articles**, one per category, in `CATEGORY_ORDER`.
- [ ] **No proper nouns in the vocabulary.** Check `vocab_new` on the new rows
      and the new entries in `vocabulary`. Any of "KI", "DAX", "Apple",
      "Bundestag" appearing means `lib/vocab.ts` didn't come across intact.
- [ ] **Nouns carry their article** — "die Auswirkung", not "Auswirkung".
- [ ] **Topic diversity.** Run it two days running (or with `BRIEFING_DATE`
      set) and confirm day two doesn't repeat day one's subjects. This is the
      single most likely thing to silently break, because it depends on
      `getRecentTopics` reading history back *and* the shortlist prompt
      receiving it.
- [ ] **`topic_tag` is populated** on every row. It's what the diversity check
      reads. Nullable for old rows, but new ones should always have it.
- [ ] **8–12 footnotes per article**, each a real learnable word.
- [ ] **`scrape_budget` shows ~30 used** for the day, and a second run the same
      day is correctly starved rather than spending another 30.
- [ ] **No email sent**, and no `resend` in `package.json` or `node_modules`.

Run it against the live Supabase project with `BRIEFING_DATE` set to a date the
old app hasn't used, so you don't overwrite a real briefing while testing.

## 2.6 Acceptance criteria

- [ ] Every file in 2.1 is byte-identical to the old repo (modulo the one URL)
- [ ] `lib/email.ts` gone, `resend` uninstalled, no `RESEND_*` env references
- [ ] `npm run briefing` writes five good articles and sends no email
- [ ] The diversity and vocabulary checks above all pass
- [ ] `npm run typecheck` clean
