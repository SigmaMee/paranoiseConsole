alter table public.submission_slots rename to episodes;

alter index public.submission_slots_resident_show_idx rename to episodes_resident_show_idx;
alter index public.submission_slots_airing_date_idx rename to episodes_airing_date_idx;

alter policy submission_slots_select_own on public.episodes rename to episodes_select_own;

create or replace function public.claim_episode_media(
  requested_producer_email text,
  requested_show_start_at timestamptz,
  requested_airing_date date,
  requested_audio boolean,
  requested_image boolean,
  requested_claim_token uuid
)
returns public.episodes
language sql
security definer
set search_path = public
as $$
  select public.claim_submission_slot_media(
    requested_producer_email,
    requested_show_start_at,
    requested_airing_date,
    requested_audio,
    requested_image,
    requested_claim_token
  );
$$;

create or replace function public.finalize_episode_media(
  requested_claim_token uuid,
  requested_audio_filename text,
  requested_image_filename text,
  requested_image_object_key text,
  requested_audio_success boolean,
  requested_image_success boolean
)
returns public.episodes
language sql
security definer
set search_path = public
as $$
  select public.finalize_submission_slot_media(
    requested_claim_token,
    requested_audio_filename,
    requested_image_filename,
    requested_image_object_key,
    requested_audio_success,
    requested_image_success
  );
$$;

revoke all on function public.claim_episode_media(text, timestamptz, date, boolean, boolean, uuid) from public, anon, authenticated;
revoke all on function public.finalize_episode_media(uuid, text, text, text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.claim_episode_media(text, timestamptz, date, boolean, boolean, uuid) to service_role;
grant execute on function public.finalize_episode_media(uuid, text, text, text, boolean, boolean) to service_role;

-- Temporary read-only compatibility surface for the currently deployed application.
-- It can be removed after all application deployments read from public.episodes.
create view public.submission_slots
with (security_invoker = true)
as select * from public.episodes;

revoke all on public.submission_slots from public, anon;
grant select on public.submission_slots to authenticated;
