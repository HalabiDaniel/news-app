# Phase 3 — Scheduling and operations

Get the daily run happening again: free, reliable, and at a sensible hour.

**Done when:** the briefing runs every morning without intervention, arrives
close to the intended time, and failures are visible.

---

## 3.1 Free minutes

Public repositories get **unlimited GitHub Actions minutes on standard
runners**. The 2,000-minute meter that blocked the old repo simply doesn't
apply. No spending limit to raise, no card to fix, nothing to monitor.

This is the whole fix for the original failure. It needs no code.

## 3.2 The lateness problem

The old workflow asked for `0 4 * * *`. Observed start times for the last ten
runs:

| Scheduled | Actually started | Late by |
|---|---|---|
| 04:00 UTC | 09:02 | 5h 02m |
| 04:00 UTC | 09:21 | 5h 21m |
| 04:00 UTC | 08:36 | 4h 36m |
| 04:00 UTC | 08:12 | 4h 12m |
| 04:00 UTC | 08:23 | 4h 23m |
| 04:00 UTC | 08:28 | 4h 28m |
| 04:00 UTC | 08:26 | 4h 26m |
| 04:00 UTC | 08:24 | 4h 24m |
| 04:00 UTC | 08:43 | 4h 43m |
| 04:00 UTC | 08:11 | 4h 11m |

Not occasional jitter — consistently 4 to 5 hours. A briefing meant for 06:00
Berlin has been landing between 10:00 and 11:15.

This mattered less when the email sat in an inbox until you opened it. With a
push notification it matters a lot: a 10:30 buzz for a "morning briefing" is
the wrong product.

### Mitigation 1: don't schedule on the hour

GitHub queues every `minute 0` schedule on the planet at the same instant.
Documented advice is to pick an off-peak minute. Use:

```yaml
on:
  schedule:
    - cron: '23 3 * * *'   # 04:23 / 05:23 Berlin, off the hour
```

This is free, it's one line, and it's the documented remedy — but it is a
best-effort improvement, not a guarantee. GitHub explicitly does not promise
scheduled workflows fire on time.

### Mitigation 2 (recommended): an external trigger

If Mitigation 1 doesn't bring it inside ~15 minutes after a week of observation,
stop relying on GitHub's scheduler and keep the runner:

1. Add `workflow_dispatch` (already present) as the real entry point.
2. Create a fine-grained PAT scoped to this repo with **Actions: write** only.
3. Point a free external cron — [cron-job.org](https://cron-job.org) or Upstash
   QStash, both free at this volume — at the dispatch endpoint:

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/daily-briefing.yml/dispatches
Authorization: Bearer <PAT>
Accept: application/vnd.github+json
Content-Type: application/json

{"ref":"main"}
```

External crons fire within a minute or two. You keep the unlimited Actions
runner and its unlimited runtime; you just stop asking GitHub to decide *when*.

Keep the `schedule:` trigger as a backstop — a duplicate run the same day is
harmless, because `runBriefing` skips a date whose `briefing_runs.status` is
already `completed`.

**Decide this by measurement, not up front.** Ship Mitigation 1, watch for a
week, add Mitigation 2 only if needed.

### Timing note

Whatever the mechanism, GitHub cron is **always UTC and does not follow
daylight saving**. `23 3 * * *` is 05:23 Berlin in summer and 04:23 in winter.
The old workflow documented this; keep the comment.

## 3.3 The 60-day disable

Public repositories have a rule private ones don't: **scheduled workflows are
automatically disabled after 60 days with no repository activity.** GitHub
emails a warning first.

Once the app is stable, "no activity for 60 days" is exactly the state this
repo will be in — and the failure mode is silent: no run, no error, no
notification. Options:

1. **Just re-enable it** when the warning email arrives. One click, twice a
   year. Fine if you'll actually read the email.
2. **Adopt Mitigation 2 above.** An external cron uses `workflow_dispatch`,
   which is never auto-disabled. This is a second good reason to do it.

Don't solve this with a bot that commits an empty file on a schedule — it
pollutes history and it's exactly as fragile as the thing it's working around.

The monitoring in 3.5 catches this either way: a briefing that doesn't exist
looks the same whether the workflow was disabled or failed.

## 3.4 The workflow file

Copy `.github/workflows/daily-briefing.yml` and change:

**Remove** the three Resend secrets from `env:`:

```diff
-          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
-          RESEND_FROM_EMAIL: ${{ secrets.RESEND_FROM_EMAIL }}
-          RECIPIENT_EMAIL: ${{ secrets.RECIPIENT_EMAIL }}
```

**Add** the VAPID pair for Phase 5:

```yaml
          VAPID_PUBLIC_KEY: ${{ secrets.VAPID_PUBLIC_KEY }}
          VAPID_PRIVATE_KEY: ${{ secrets.VAPID_PRIVATE_KEY }}
          VAPID_SUBJECT: ${{ vars.VAPID_SUBJECT }}
```

**Change** the cron to the off-peak minute.

**Keep** everything else, in particular:

- The long `env:` block mapping every tuning variable. The existing comment
  explains why and it is the single most non-obvious thing about this workflow:
  *a variable stored in the GitHub UI does not reach the run on its own.*
  Actions only exposes what the workflow explicitly maps into `env:`. Anything
  you add in Settings must also be listed here, or the code silently falls back
  to its built-in default. This has already cost one debugging session
  (`OPENAI_MODEL`, PR #9). **Preserve the comment verbatim.**
- `concurrency: { group: daily-briefing, cancel-in-progress: false }` — two
  runs must never write the same day.
- `timeout-minutes: 20`.
- `cache: 'npm'` on `setup-node`.

**Do not** add any other trigger. `schedule` and `workflow_dispatch` only —
see the fork-secrets note in Phase 1.

### Secrets and variables to create

Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`,
`FIRECRAWL_API_KEY`, `CRON_SECRET`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.

Variables: `SITE_URL` (the new Vercel URL), `VAPID_SUBJECT`, plus any tuning
knob you currently override.

Check the old repo's Settings → Secrets and variables for tuning overrides
before deleting it in Phase 6. Anything set there and not carried across will
silently revert to a default.

## 3.5 Knowing when it breaks

The old setup had no monitoring. A failed run meant no email, which you'd
notice — eventually, and only by its absence. With push, a failure is even
quieter: no notification looks exactly like not having picked up your phone.

Minimum viable monitoring, in order of effort:

1. **Turn on GitHub's own notifications.** Settings → Notifications → Actions →
   "Send notifications for failed workflows only". Free, catches every failed
   run. Doesn't catch a run that never started.
2. **A staleness check in the UI.** Phase 4's empty state should say *when* the
   last briefing was, not just that today's is missing. "Letztes Briefing:
   vor 3 Tagen" is a working monitor you'll see every morning.
3. **A watchdog workflow** (optional). A second scheduled job, a few hours
   after the first, that queries `briefing_runs` for today and fails loudly if
   there's no `completed` row. Catches the disabled-workflow case that (1)
   misses. Cheap on a public repo.

Start with (1) and (2). Add (3) if the 60-day disable actually bites.

## 3.6 Acceptance criteria

- [ ] Workflow runs on the new public repo with no billing error
- [ ] Email secrets removed; VAPID secrets added
- [ ] Cron is off-the-hour; the UTC/DST comment is intact
- [ ] The full tuning `env:` block and its comment carried over
- [ ] `workflow_dispatch` produces a complete briefing end to end
- [ ] Start times observed for a week and recorded
- [ ] Failure notifications enabled
