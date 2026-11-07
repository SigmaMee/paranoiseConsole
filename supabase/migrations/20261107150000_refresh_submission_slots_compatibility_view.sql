-- Views created with `select *` do not automatically gain columns that are
-- added to their source table later. Refresh the temporary compatibility view
-- so the legacy media functions return the current public.episodes row type.

create or replace view public.submission_slots
with (security_invoker = true)
as select * from public.episodes;

revoke all on public.submission_slots from public, anon;
grant select on public.submission_slots to authenticated;
