-- ============================================================================
-- Daily German B2 News Briefing — database schema
-- Run this in the Supabase SQL editor (SQL Editor > New query > Run).
-- Safe to re-run: uses "if not exists" and idempotent seeds.
-- ============================================================================

create table if not exists articles (
  id uuid primary key default gen_random_uuid(),
  briefing_date date not null,
  category text not null check (category in ('politics','finance','technology','gaming','germany')),
  title_en text not null,
  source_url text,
  summary_en text not null,
  topic_tag text,
  title_de text not null,
  content_de text not null,
  footnotes jsonb default '[]'::jsonb,
  vocab_used text[] default '{}',
  vocab_new text[] default '{}',
  created_at timestamptz default now()
);

-- Added after the first release: give already-deployed databases the column too
-- (re-running the whole file is meant to be safe). Stores the per-article glossary
-- of highlighted words → short German explanations.
alter table articles add column if not exists footnotes jsonb default '[]'::jsonb;

-- Added for the diversity check: a short English label for what each story was
-- ABOUT ("pension reform bill", "drought in Brandenburg"). Every morning the
-- selection step reads the last week of these back and refuses to pick a story
-- on a subject that already appears — which is what stops Politik being about
-- the same person every day. Nullable, so briefings written before this column
-- existed are still valid history (the title is used as a weaker fallback).
alter table articles add column if not exists topic_tag text;

create index if not exists idx_articles_date on articles(briefing_date);

create table if not exists vocabulary (
  id uuid primary key default gen_random_uuid(),
  german_word text not null unique,
  english_translation text not null,
  cefr_level text default 'B2',
  date_first_introduced date default current_date,
  times_used_total integer default 0,
  last_used_date date,
  created_at timestamptz default now()
);

create table if not exists briefing_runs (
  id uuid primary key default gen_random_uuid(),
  briefing_date date not null unique,
  status text not null default 'pending',
  error_message text,
  email_sent boolean default false,
  created_at timestamptz default now()
);

-- ----------------------------------------------------------------------------
-- The daily Firecrawl ceiling.
--
-- The pipeline scrapes a SHORTLIST of 4-6 articles per category and then picks
-- the most interesting one from the real text, so a run fetches up to 30 pages
-- instead of 5. The count has to hold across runs, not just within one: the
-- scheduled GitHub Actions job, the in-app "generate now" button and a local
-- `npm run briefing -- --force` are three separate processes that could each
-- otherwise spend a full day's budget.
--
-- One row per day, holding the number of scrapes ATTEMPTED (a paywalled page
-- costs the same credit as a good one). Credits are claimed before the fetches
-- happen, with a compare-and-set on scrapes_used, so two runs racing on the same
-- row can never both spend the same credits. Old rows are only a log — delete
-- them whenever you like.
-- ----------------------------------------------------------------------------
create table if not exists scrape_budget (
  scrape_date date primary key,
  scrapes_used integer not null default 0,
  updated_at timestamptz default now()
);

-- ----------------------------------------------------------------------------
-- Starter vocabulary so the very first run has words to repeat.
-- `on conflict do nothing` makes this safe to run multiple times.
-- ----------------------------------------------------------------------------
insert into vocabulary (german_word, english_translation, cefr_level) values
  ('die Auswirkung',            'the impact / effect',                'B2'),
  ('die Herausforderung',       'the challenge',                      'B2'),
  ('sich auseinandersetzen mit','to engage with / grapple with',      'B2'),
  ('die Entwicklung',           'the development',                    'B2'),
  ('im Hinblick auf',           'with regard to',                     'B2'),
  ('die Voraussetzung',         'the prerequisite / precondition',    'B2'),
  ('sich durchsetzen',          'to prevail / assert oneself',        'B2'),
  ('die Auseinandersetzung',    'the dispute / debate / confrontation','B2'),
  ('verhältnismäßig',           'relatively / proportionate',         'B2'),
  ('die Regierung',             'the government',                     'B2'),
  ('die Maßnahme',              'the measure / step',                 'B2'),
  ('zunehmen',                  'to increase / grow',                 'B2'),
  ('der Zusammenhang',          'the context / connection',           'B2'),
  ('nachhaltig',                'sustainable / lasting',              'B2'),
  ('die Wirtschaft',            'the economy',                       'B2')
on conflict (german_word) do nothing;

-- ----------------------------------------------------------------------------
-- Push subscriptions — the notification that replaced the email.
--
-- One row per browser / PWA install. `endpoint` is unique because re-subscribing
-- (a reinstall, a permission reset) hands back the same endpoint and must update
-- the row rather than add a second one that would push twice to one phone.
--
-- Written server-side with the service role key only, so RLS is enabled with NO
-- policies: if the anon key is ever pointed at this table by mistake, it is shut.
-- ----------------------------------------------------------------------------
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

alter table push_subscriptions enable row level security;

-- Counts a delivery failure without reading the row first (lib/push.ts calls this
-- by RPC). A 404/410 deletes the subscription instead — anything else is
-- transient, and the count is only there to spot an endpoint that never recovers.
create or replace function increment_push_failure(ep text)
returns void
language sql
as $$
  update push_subscriptions
     set failure_count = failure_count + 1
   where endpoint = ep;
$$;

-- Replaces email_sent. An integer (how many devices were notified), not a
-- boolean: when a push doesn't arrive the first question is always "did it go to
-- zero devices, or did it go and get swallowed?", and a boolean can't answer it.
-- The old column is left in place — dropping it would break the old app before
-- cutover, and it costs nothing to keep.
alter table briefing_runs add column if not exists push_sent integer;
