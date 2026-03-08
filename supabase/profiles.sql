create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  producer_email text not null unique,
  full_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists profiles_email_idx on public.profiles (producer_email);

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

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
for select
using (
  user_id = auth.uid()
  or (
    user_id is null
    and lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
  )
);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
for insert
with check (
  auth.uid() = user_id
  and lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
for update
using (
  user_id = auth.uid()
  or (
    user_id is null
    and lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
  )
)
with check (
  auth.uid() = user_id
  and lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
);
