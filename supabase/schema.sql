-- ORBITAL VISION — Supabase schema (Postgres + PostGIS)
-- Run in the Supabase SQL editor of a new project.

create extension if not exists postgis;

-- ---------- profiles / roles ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  role text not null default 'analyst' check (role in ('analyst', 'admin')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name) values (new.id, new.email) on conflict do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- ---------- projects ----------
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

-- ---------- areas of interest ----------
create table if not exists public.aois (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  name text,
  geojson jsonb not null,
  geom geometry (Geometry, 4326),
  created_at timestamptz not null default now()
);
create index if not exists aois_geom_idx on public.aois using gist (geom);

-- ---------- acquisition / archive requests ----------
create table if not exists public.acquisition_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  title text not null,
  kind text not null check (kind in ('archive', 'new_acquisition')),
  provider_id text not null,
  sensor text,
  aoi jsonb,
  aoi_geom geometry (Geometry, 4326),
  params jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in (
    'draft','searching_archives','results_available','awaiting_quote','awaiting_confirmation',
    'submitted_to_provider','accepted_by_provider','scheduled','acquired','processing',
    'delivered','failed','cancelled')),
  -- every status change with its source: platform | user_reported | provider_api
  history jsonb not null default '[]'::jsonb,
  delivery_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists req_geom_idx on public.acquisition_requests using gist (aoi_geom);

-- keep PostGIS geometry in sync with the GeoJSON column
create or replace function public.sync_geom() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'aois' then
    new.geom := case when new.geojson is null then null else st_setsrid(st_geomfromgeojson(new.geojson::text), 4326) end;
  else
    new.aoi_geom := case when new.aoi is null then null else st_setsrid(st_geomfromgeojson(new.aoi::text), 4326) end;
  end if;
  return new;
end $$;

drop trigger if exists aois_geom on public.aois;
create trigger aois_geom before insert or update on public.aois for each row execute function public.sync_geom();
drop trigger if exists req_geom on public.acquisition_requests;
create trigger req_geom before insert or update on public.acquisition_requests for each row execute function public.sync_geom();

-- ---------- provider integrations (no secrets here — secrets live in server env vars) ----------
create table if not exists public.provider_integrations (
  provider_id text primary key,
  enabled boolean not null default false,
  mode text not null default 'manual' check (mode in ('manual', 'api')),
  notes text,
  updated_at timestamptz not null default now()
);

-- ---------- audit log ----------
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  at timestamptz not null default now(),
  action text not null,
  detail jsonb
);

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.aois enable row level security;
alter table public.acquisition_requests enable row level security;
alter table public.provider_integrations enable row level security;
alter table public.audit_logs enable row level security;

create policy "own profile" on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "admin edits profiles" on public.profiles for update using (public.is_admin());

create policy "own projects" on public.projects for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own aois" on public.aois for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own requests" on public.acquisition_requests for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "admin reads requests" on public.acquisition_requests for select using (public.is_admin());

create policy "read integrations" on public.provider_integrations for select using (auth.role() = 'authenticated');
create policy "admin writes integrations" on public.provider_integrations for all using (public.is_admin()) with check (public.is_admin());

create policy "insert own audit" on public.audit_logs for insert with check (user_id = auth.uid());
create policy "read own audit" on public.audit_logs for select using (user_id = auth.uid() or public.is_admin());

-- Make yourself admin after first sign-in:
-- update public.profiles set role = 'admin' where display_name = 'you@example.com';
