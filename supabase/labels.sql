-- ORBITAL VISION — labels people put on detected changes (what a spot really is).
-- Run this in the Supabase SQL editor AFTER schema.sql. Safe to run again.
--
-- One row per labelled detection: where it is, what it was labelled, and the images and
-- measurements behind it — the training set for a later classifier, and the memory that lets
-- the app show "labelled before as …" on the next detection at the same place.
-- Each user sees and edits only their own labels.

create table if not exists public.change_labels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  label text not null check (label in ('track', 'clearing', 'farm', 'structure', 'fire', 'water', 'seasonal', 'false_alarm', 'other')),
  note text,
  lon double precision not null,
  lat double precision not null,
  area_km2 double precision,
  length_km double precision,
  -- where the detection came from: change (two scenes) · trend (multi-scene) · watch (automatic)
  source text not null default 'change' check (source in ('change', 'trend', 'watch')),
  purpose text,
  aoi_name text,
  a_scene text,
  b_scene text,
  a_datetime timestamptz,
  b_datetime timestamptz,
  -- measurements at labelling time (shape, NDVI drop, growth direction …) for training
  features jsonb not null default '{}'::jsonb
);
create index if not exists change_labels_user_idx on public.change_labels (user_id, created_at desc);
create index if not exists change_labels_pos_idx on public.change_labels (lat, lon);

alter table public.change_labels enable row level security;
drop policy if exists "own change labels" on public.change_labels;
create policy "own change labels" on public.change_labels for all using (user_id = auth.uid()) with check (user_id = auth.uid());
