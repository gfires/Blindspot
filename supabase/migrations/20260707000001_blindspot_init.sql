create schema if not exists blindspot;

-- Unified cache for search results and scraped content
create table blindspot.cache (
  type       text    not null check (type in ('search', 'scrape')),
  key        text    not null,
  value      jsonb   not null,
  created_at timestamptz default now(),
  primary key (type, key)
);

-- Blocklist of scrape-hostile domains
create table blindspot.blocklist (
  domain    text primary key,
  reason    text not null,
  added_at  timestamptz not null
);

-- Leaderboard: one row per industry, upserted to keep highest score
create table blindspot.leaderboard (
  industry   text primary key,
  score      int     not null,
  sub_scores jsonb   not null,
  scanned_at timestamptz default now()
);
create index on blindspot.leaderboard (score desc);
