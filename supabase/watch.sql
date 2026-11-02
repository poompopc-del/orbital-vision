-- ORBITAL VISION — automatic area watch ("CCTV from orbit")
-- Run this in the Supabase SQL editor AFTER schema.sql. Safe to run again.
--
-- The website writes watch_areas (each user sees only their own).
-- The automatic checker (GitHub Actions, service-role key) reads the areas, records every
-- scene it looked at, stores comparison results and alerts, and uploads report images
-- to the public storage bucket "watch" under unguessable ids.

-- ---------- areas being watched ----------
create table if not exists public.watch_areas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  region text not null default 'OTHER',
  purpose text not null default 'clearing',
  sensor text not null default 'optical',
  geometry jsonb not null,
  active boolean not null default true,
  -- alert when the latest comparison is at least this level: significant | minor | any
  notify_level text not null default 'significant' check (notify_level in ('significant', 'minor', 'any')),
  -- where to email alerts (empty = the account's email)
  notify_email text,
  notes text,
  last_checked_at timestamptz,
  last_scene_at timestamptz,
  edited_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists watch_areas_user_idx on public.watch_areas (user_id);

-- ---------- every scene the checker has examined for an area ----------
create table if not exists public.watch_scenes (
  area_id uuid not null references public.watch_areas (id) on delete cascade,
  scene_id text not null,
  collection text not null,
  datetime timestamptz not null,
  scene_cloud real,
  aoi_cloud real,
  aoi_shadow real,
  usable boolean not null,
  reasons text,
  checked_at timestamptz not null default now(),
  primary key (area_id, scene_id)
);
create index if not exists watch_scenes_usable_idx on public.watch_scenes (area_id, usable, datetime desc);

-- ---------- comparison results ----------
-- horizon: latest = newest usable scene vs the previous usable one;
--          week / month / year = newest usable scene vs the usable scene nearest 7 / 30 / 365 days earlier
create table if not exists public.watch_runs (
  id uuid primary key default gen_random_uuid(),
  area_id uuid not null references public.watch_areas (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  horizon text not null check (horizon in ('latest', 'week', 'month', 'year')),
  trigger_scene text not null,
  status text not null,
  level text,
  confidence text,
  change_km2 double precision,
  valid_pct double precision,
  a_datetime timestamptz,
  b_datetime timestamptz,
  run jsonb not null,
  images jsonb,
  created_at timestamptz not null default now()
);
create index if not exists watch_runs_area_idx on public.watch_runs (area_id, created_at desc);

-- ---------- alerts ----------
create table if not exists public.watch_alerts (
  id uuid primary key default gen_random_uuid(),
  area_id uuid not null references public.watch_areas (id) on delete cascade,
  run_id uuid not null references public.watch_runs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  level text,
  emailed_to text,
  emailed_at timestamptz,
  email_error text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists watch_alerts_user_idx on public.watch_alerts (user_id, created_at desc);

-- ---------- row level security ----------
alter table public.watch_areas enable row level security;
alter table public.watch_scenes enable row level security;
alter table public.watch_runs enable row level security;
alter table public.watch_alerts enable row level security;

drop policy if exists "own watch areas" on public.watch_areas;
create policy "own watch areas" on public.watch_areas for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own watch scenes" on public.watch_scenes;
create policy "own watch scenes" on public.watch_scenes for select
  using (exists (select 1 from public.watch_areas a where a.id = area_id and a.user_id = auth.uid()));

drop policy if exists "own watch runs" on public.watch_runs;
create policy "own watch runs" on public.watch_runs for select using (user_id = auth.uid());
drop policy if exists "delete own watch runs" on public.watch_runs;
create policy "delete own watch runs" on public.watch_runs for delete using (user_id = auth.uid());

drop policy if exists "own watch alerts" on public.watch_alerts;
create policy "own watch alerts" on public.watch_alerts for select using (user_id = auth.uid());
drop policy if exists "mark own alerts read" on public.watch_alerts;
create policy "mark own alerts read" on public.watch_alerts for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- report images ----------
-- Public read so images show inside alert emails; paths are random ids, not listable by visitors.
insert into storage.buckets (id, name, public) values ('watch', 'watch', true)
  on conflict (id) do update set public = true;
