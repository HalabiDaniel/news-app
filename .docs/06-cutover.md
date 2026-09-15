# Phase 6 — Cutover

Switch over, then retire the old setup.

**Done when:** the new app is the only one running and the old repo is archived.

---

## 6.1 Run both for a week

Don't retire anything until the new pipeline has produced seven consecutive
good briefings. Most of what can go wrong here is invisible on day one:

- The topic-diversity check needs several days of history before it's doing
  anything at all.
- Push subscriptions can expire silently.
- The scheduled run's real start time (Phase 3.2) only shows up over a week.

Both apps read and write the **same Supabase project**, so they must not both
generate. During the overlap:

1. **Disable the old workflow.** Actions → Daily Briefing → ⋯ → *Disable
   workflow*. Reversible in one click, which is what you want if the new one
   stumbles.
2. Leave the old Vercel deployment serving. It reads the same `articles` table,
   so it keeps showing whatever the new pipeline writes — a useful sanity check
   that the data is shaped identically.
3. Keep the old email path available as a manual fallback for exactly as long
   as the old repo exists: if push fails on day three, you can re-enable the old
   workflow and get an email while you debug.

That last point is the real reason not to delete anything early. Once the old
repo is gone, push is the only delivery mechanism and there is no fallback.

## 6.2 No data migration

Nothing to move. Same project, same tables. Article and vocabulary history
carries over because it never went anywhere.

Verify before switching:

- [ ] `articles` rows written by the new pipeline are indistinguishable from
      old ones — same columns populated, `topic_tag` present, `footnotes` a
      well-formed array
- [ ] `vocabulary` counters still increment (`times_used_total`,
      `last_used_date`)
- [ ] The new app's archive renders articles written by the *old* pipeline
      correctly, including rows from before `topic_tag` existed (it's nullable
      for exactly that reason)

That last one is the easy thing to miss: the new UI must handle the full
history, not just what it wrote itself.

## 6.3 Switching over

Once the week is clean:

1. **Point the URL at the new app.** If you're on the default
   `*.vercel.app` domain, the "switch" is just using the new URL — but your
   phone's home-screen app is pinned to the *old* origin, so you must delete
   and re-add it, then re-subscribe to push (Phase 5.1, point 6).
   If you'd rather not redo that ever again, buy a small domain now and point
   it at the new project. Then the origin is stable for good.
2. **Re-install the PWA** from the final URL, grant notifications, send a test
   push.
3. **Confirm the next scheduled run notifies** the re-installed app.

Do step 1 deliberately. Every future origin change costs you the home-screen
app and every push subscription.

## 6.4 Decommission

Only after the new app has notified you from its final URL:

- [ ] **Delete the old Vercel project** (or pause it). Two deployments reading
      the same database is a confusing state to debug later.
- [ ] **Revoke the Resend API key.** It is no longer used by anything.
- [ ] Remove `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RECIPIENT_EMAIL` from the
      old repo's secrets.
- [ ] **Copy across any tuning overrides first.** Check the old repo's
      Settings → Secrets and variables → Variables for anything you set there
      (`OPENAI_MODEL`, feed overrides, any `FIRECRAWL_*` or `OPENAI_*` knob).
      Anything not carried over reverts to a built-in default silently — see
      the workflow comment quoted in Phase 3.4.
- [ ] **Archive the old repo** (Settings → Archive this repository). Archive,
      don't delete: it's the history of how the pipeline got tuned, the PR
      discussions explain several non-obvious constants, and archiving is
      reversible.
- [ ] Rotate `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` and
      `FIRECRAWL_API_KEY` if you'd like a clean break, updating both Vercel and
      Actions. Optional — none of them were ever in the repo — but it's a
      natural moment.

## 6.5 What to write down

The new repo's README should carry over the old one's operational content —
it's genuinely good and took time to write — updated for the changes:

- The six-stage pipeline explanation
- Why the run is in Actions and not Vercel cron
- The tuning knobs table, and **the warning that a GitHub variable must also be
  mapped into the workflow's `env:` block**
- Supabase setup
- `npm run check-feeds` / `check-models` for diagnosis

New sections needed:

- **Adding a device**: open in Safari → Add to Home Screen → enable
  notifications → test push. Write this down; you'll need it after any origin
  change and won't remember the order.
- **When no notification arrives**: check `briefing_runs` for today's row and
  `push_sent`; send a test push; if the test fails, re-subscribe. Three steps,
  in that order, because each rules out a different layer.
- **The 60-day scheduled-workflow disable** (Phase 3.3) and what to do about
  the warning email.

## 6.6 Acceptance criteria

- [ ] Seven consecutive good briefings from the new pipeline
- [ ] New UI renders the full archive, including pre-`topic_tag` rows
- [ ] PWA installed from the final URL, push confirmed working there
- [ ] Old workflow disabled, old Vercel project removed
- [ ] Resend key revoked; all email env vars gone
- [ ] Tuning overrides carried across and verified
- [ ] Old repo archived
- [ ] README covers device setup and the no-notification checklist
