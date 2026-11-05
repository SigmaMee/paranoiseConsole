drop policy if exists submission_slots_select_own on public.submission_slots;
create policy submission_slots_select_own on public.submission_slots
for select
to authenticated
using (lower(producer_email) = lower(coalesce((select auth.jwt())->>'email', '')));
