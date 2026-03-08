-- Cleanup deprecated profile fields from legacy Webflow flow
-- and enforce user_id-first ownership to prevent identity drift.

-- 1) Backfill user_id / producer_email for rows that match auth users by email
update public.profiles p
set
  user_id = au.id,
  producer_email = lower(au.email)
from auth.users au
where lower(p.producer_email) = lower(au.email)
  and (
    p.user_id is distinct from au.id
    or p.producer_email is distinct from lower(au.email)
  );

-- 2) Drop legacy Webflow/sync columns no longer used by runtime
alter table public.profiles drop column if exists bio;
alter table public.profiles drop column if exists location;
alter table public.profiles drop column if exists avatar_url;
alter table public.profiles drop column if exists social_url;
alter table public.profiles drop column if exists webflow_item_id;
alter table public.profiles drop column if exists sync_status;
alter table public.profiles drop column if exists sync_error;
alter table public.profiles drop column if exists draft_updated_at;
alter table public.profiles drop column if exists last_synced_at;

-- 3) Remove unused sync job table
drop table if exists public.profile_sync_jobs;

-- 4) Tighten policies to user_id-first ownership with fallback for unlinked legacy rows
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
