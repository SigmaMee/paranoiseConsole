-- Resolve multiple Supabase Auth users to one canonical producer identity.
-- The canonical email is stored in protected auth app_metadata, never user_metadata.

create or replace function public.current_producer_email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(
    coalesce(
      nullif(auth.jwt() -> 'app_metadata' ->> 'producer_email', ''),
      auth.jwt() ->> 'email',
      ''
    )
  );
$$;

revoke all on function public.current_producer_email() from public;
grant execute on function public.current_producer_email() to authenticated;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
for select to authenticated
using (
  user_id = (select auth.uid())
  or lower(producer_email) = (select public.current_producer_email())
);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
for insert to authenticated
with check (
  (select auth.uid()) = user_id
  and lower(producer_email) = (select public.current_producer_email())
);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
for update to authenticated
using (
  user_id = (select auth.uid())
  or lower(producer_email) = (select public.current_producer_email())
)
with check (
  lower(producer_email) = (select public.current_producer_email())
);

drop policy if exists submissions_select_own on public.submissions;
create policy submissions_select_own on public.submissions
for select to authenticated
using (
  lower(producer_email) = (select public.current_producer_email())
);
