create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  producer_email text not null unique,
  full_name text not null,
  bio text,
  location text,
  avatar_url text,
  social_url text,
  webflow_item_id text,
  sync_status text not null default 'pending',
  sync_error text,
  draft_updated_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profile_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  producer_email text not null,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists profiles_email_idx on public.profiles (producer_email);
create index if not exists profile_sync_jobs_profile_idx on public.profile_sync_jobs (profile_id);
create index if not exists profile_sync_jobs_status_idx on public.profile_sync_jobs (status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.profile_sync_jobs enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
for select
using (
  lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
for insert
with check (
  lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
for update
using (
  lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
)
with check (
  lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
);

drop policy if exists profile_sync_jobs_select_own on public.profile_sync_jobs;
create policy profile_sync_jobs_select_own on public.profile_sync_jobs
for select
using (
  lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
);

drop policy if exists profile_sync_jobs_insert_own on public.profile_sync_jobs;
create policy profile_sync_jobs_insert_own on public.profile_sync_jobs
for insert
with check (
  lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
);
