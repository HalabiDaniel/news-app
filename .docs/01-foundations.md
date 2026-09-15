# Phase 1 — Foundations

Create the public repo, scaffold the app, get the database ready. No pipeline
code and no UI yet: the goal is a repo that builds, deploys, and has somewhere
to put data.

**Done when:** the new repo is public, a bare Next.js app is live on Vercel,
`npm run typecheck` passes in CI, and the database has the new tables.

---

## 1.1 The repository

Create a **new public repository** under `HalabiDaniel`. Not a fork and not a
transfer of the old one — a transfer would carry the old repo's history and
issues, and we want the old repo left intact and running until cutover
(Phase 6).

Name it something that isn't `german-articles`. The name ends up in the Vercel
URL, so it's user-visible.

Initialise with:

```
.gitignore        # copy from the old repo verbatim — it already excludes .env, .env*.local, .vercel
README.md
LICENSE           # new: a public repo without one is ambiguous. MIT is fine.
```

### Before the first push — the public-repo checklist

The old history is clean (verified in the overview), but we are starting fresh
anyway, so the rule for the new repo is simply: **never commit a real value.**

- `.env.example` carries placeholder values only. Copy the old one; it is
  already written this way (`SUPABASE_URL=https://your-project-ref.supabase.co`).
- Enable **Push protection** and **Secret scanning** under
  Settings → Code security. Both are free on public repos and would have caught
  a mistake before it reached the internet.

### Workflow-secret safety on a public repo

Anyone can fork a public repo and open a pull request. GitHub does **not**
expose Actions secrets to workflows triggered by `pull_request` from a fork, so
the daily job's keys are safe — but only if we don't defeat that:

- The briefing workflow triggers on `schedule` and `workflow_dispatch` **only**.
  `workflow_dispatch` requires write access, so only you can fire it.
- **Never** add `pull_request_target` to a workflow that has access to secrets.
  That trigger runs the *base* repo's workflow against *fork* code with secrets
  available, and it is the standard way public repos leak keys.
- A CI workflow that runs on `pull_request` (typecheck, lint) is fine — give it
  no secrets at all.

Also set Settings → Actions → **Workflow permissions** to *Read repository
contents*. Nothing in this project needs to write to the repo.

## 1.2 Scaffold

Next.js 15, App Router, TypeScript — same stack, so the ported pipeline and the
existing server components drop straight in.

Copy from the old repo unchanged:

- `tsconfig.json` (the `@/*` path alias is used throughout the ported code)
- `next.config.mjs`
- `vercel.json`
- the `typecheck` script in `package.json`

`package.json` dependencies — the old list **minus `resend`**:

```jsonc
{
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "next": "^15.1.0",
    "openai": "^5.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "web-push": "^3.6.7"        // new, for Phase 5
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/web-push": "^3.6.4", // new
    "tsx": "^4.23.12",
    "typescript": "^5.7.0"
  }
}
```

Scripts carry over as-is: `dev`, `build`, `start`, `briefing`, `check-feeds`,
`check-models`, `typecheck`.

## 1.3 CI

One workflow, `.github/workflows/ci.yml`, on `push` and `pull_request`:
`npm ci` then `npm run typecheck` then `npm run build`. **No secrets in this
workflow** — it runs fork PR code.

This matters more than it did before. The old repo had no CI at all; a
type error would only show up when Vercel built, or at 06:00 when the briefing
ran. On a public repo with unlimited minutes there's no reason not to.

The build needs to succeed without database credentials. The old code already
handles this — `lib/queries.ts` swallows every error to an empty result
specifically so the build works with no env vars — so keep that property when
porting.

## 1.4 Database

Same Supabase project. The existing tables (`articles`, `vocabulary`,
`briefing_runs`, `scrape_budget`) stay exactly as they are — the ported
pipeline reads and writes the same shapes.

Two changes, both additive and safe to run against the live database while the
old app is still using it:

```sql
-- Push subscriptions (Phase 5). One row per browser/PWA install.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,        -- unique: re-subscribing must not duplicate
  p256dh text not null,                 -- client public key, from the browser
  auth text not null,                   -- client auth secret, from the browser
  user_agent text,                      -- for telling your devices apart when debugging
  created_at timestamptz default now(),
  last_success_at timestamptz,          -- last push the service accepted
  failure_count integer not null default 0
);

create index if not exists idx_push_subs_created on push_subscriptions(created_at);

-- Replaces email_sent. The old column is left in place: dropping it would
-- break the old app before cutover, and it costs nothing to keep.
alter table briefing_runs add column if not exists push_sent integer;
```

`push_sent` is an integer (how many devices were notified), not a boolean —
when a push doesn't arrive, the first question is always "did it go to zero
devices, or did it go and get swallowed?", and a boolean can't answer that.

Keep `supabase/schema.sql` in the new repo as the single idempotent source of
truth, the way the old one does. Re-running the whole file must stay safe.

### Row-level security

`push_subscriptions` is written from a server route handler using the service
role key, which bypasses RLS. Enable RLS on it with **no policies** so that if
the anon key is ever used against it by mistake, the table is closed:

```sql
alter table push_subscriptions enable row level security;
```

Do the same check on the existing tables. The site renders server-side with
the service key, so no table needs to be readable by the anon key.

## 1.5 Vercel

New Vercel project pointed at the new repo. Environment variables for
**Production and Preview**:

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | same project as the old app |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only, never `NEXT_PUBLIC_` |
| `CRON_SECRET` | gates the manual-trigger and revalidate routes |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Phase 5. Public by design — it goes to the browser |
| `VAPID_PRIVATE_KEY` | Phase 5. Server-only |

Don't point a custom domain at it yet. The old app stays live until Phase 6.

### Commit-author verification is on for this Vercel team

Found the hard way while writing this plan: the **Eddan Group** team has
Vercel's Git commit-author verification enabled. A deployment is blocked —
before any build is attempted — when GitHub cannot attribute the commit to a
user account with access to the team:

> GitHub couldn't verify an account for commit `<sha>`. Vercel blocks this
> deployment before it can verify the account's access to the team.

The trigger is a commit authored with an email address that isn't registered
and verified on the GitHub account. It has nothing to do with the diff, so it
looks like an infrastructure fault and isn't one.

Carry two things into the new project:

- **Author commits with an email GitHub attributes to you.**
  `daniel.halabi.de@gmail.com` is the one already used in this repo's history;
  `223320706+HalabiDaniel@users.noreply.github.com` also works and keeps the
  address private. If `git log` shows an author GitHub renders without an
  avatar and a profile link, deploys will be blocked.
- **Amending is not enough on its own** — Vercel verifies per commit, so a
  blocked commit needs a *new* commit (a re-authored one counts) before the
  deployment is retried.

This matters more once agents commit to the repo routinely: the failure is
silent from the code's point of view and the error names GitHub, not the
setting that caused it.

## 1.6 Acceptance criteria

- [ ] New public repo exists, with secret scanning and push protection on
- [ ] Workflow permissions set to read-only; no `pull_request_target` anywhere
- [ ] `npm run typecheck` and `npm run build` pass in CI on a PR
- [ ] Vercel deploys the placeholder app successfully
- [ ] `schema.sql` runs clean against the live Supabase project, twice in a row
- [ ] `push_subscriptions` exists with RLS enabled and no policies
- [ ] The old app is still running and unaffected
