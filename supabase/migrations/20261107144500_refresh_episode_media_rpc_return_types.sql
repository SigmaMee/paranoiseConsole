-- The episode metadata migration added columns after these wrappers were created.
-- Recreate them as PL/pgSQL wrappers so their composite return value is resolved
-- against the current public.episodes row type when the function executes.

create or replace function public.claim_episode_media(
  requested_producer_email text,
  requested_show_start_at timestamptz,
  requested_airing_date date,
  requested_audio boolean,
  requested_image boolean,
  requested_claim_token uuid
)
returns public.episodes
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.claim_submission_slot_media(
    requested_producer_email,
    requested_show_start_at,
    requested_airing_date,
    requested_audio,
    requested_image,
    requested_claim_token
  );
end;
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
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.finalize_submission_slot_media(
    requested_claim_token,
    requested_audio_filename,
    requested_image_filename,
    requested_image_object_key,
    requested_audio_success,
    requested_image_success
  );
end;
$$;

revoke all on function public.claim_episode_media(text, timestamptz, date, boolean, boolean, uuid)
  from public, anon, authenticated;
revoke all on function public.finalize_episode_media(uuid, text, text, text, boolean, boolean)
  from public, anon, authenticated;
grant execute on function public.claim_episode_media(text, timestamptz, date, boolean, boolean, uuid)
  to service_role;
grant execute on function public.finalize_episode_media(uuid, text, text, text, boolean, boolean)
  to service_role;
