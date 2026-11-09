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
declare
  episode public.episodes;
  stale_before timestamptz := now() - interval '1 hour';
  edit_deadline timestamptz;
begin
  if not requested_audio and not requested_image then
    raise exception 'At least one media component must be claimed.' using errcode = '22023';
  end if;

  insert into public.episodes (producer_email, show_start_at, airing_date)
  values (lower(requested_producer_email), requested_show_start_at, requested_airing_date)
  on conflict do nothing;

  select * into episode
  from public.episodes
  where lower(producer_email) = lower(requested_producer_email)
    and show_start_at = requested_show_start_at
  for update;

  edit_deadline := (episode.airing_date::timestamp + time '09:00') at time zone 'Europe/Athens';
  if now() >= edit_deadline then
    raise exception 'This episode closed for editing at 09:00 Europe/Athens on its airtime date.' using errcode = '23505';
  end if;

  if requested_audio and episode.audio_claim_token is not null and episode.audio_claimed_at >= stale_before then
    raise exception 'Audio is already being submitted.' using errcode = '23505';
  end if;

  if requested_image and episode.image_claim_token is not null and episode.image_claimed_at >= stale_before then
    raise exception 'Artwork is already being submitted.' using errcode = '23505';
  end if;

  update public.episodes
  set
    audio_claim_token = case when requested_audio then requested_claim_token else audio_claim_token end,
    audio_claimed_at = case when requested_audio then now() else audio_claimed_at end,
    image_claim_token = case when requested_image then requested_claim_token else image_claim_token end,
    image_claimed_at = case when requested_image then now() else image_claimed_at end,
    updated_at = now()
  where id = episode.id
  returning * into episode;

  return episode;
end;
$$;

create or replace function public.save_episode_metadata(
  requested_producer_email text,
  requested_show_start_at timestamptz,
  requested_airing_date date,
  requested_description text,
  requested_tags text[]
)
returns public.episodes
language plpgsql
security definer
set search_path = public
as $$
declare
  episode public.episodes;
  edit_deadline timestamptz;
begin
  if char_length(coalesce(requested_description, '')) > 1000 then
    raise exception 'Description cannot exceed 1000 characters.' using errcode = '22023';
  end if;

  if cardinality(coalesce(requested_tags, '{}')) > 5 then
    raise exception 'An episode cannot have more than 5 tags.' using errcode = '22023';
  end if;

  insert into public.episodes (producer_email, show_start_at, airing_date)
  values (lower(requested_producer_email), requested_show_start_at, requested_airing_date)
  on conflict do nothing;

  select * into episode
  from public.episodes
  where lower(producer_email) = lower(requested_producer_email)
    and show_start_at = requested_show_start_at
  for update;

  edit_deadline := (episode.airing_date::timestamp + time '09:00') at time zone 'Europe/Athens';
  if now() >= edit_deadline then
    raise exception 'This episode closed for editing at 09:00 Europe/Athens on its airtime date.' using errcode = '23505';
  end if;

  update public.episodes
  set
    description = trim(coalesce(requested_description, '')),
    tags = coalesce(requested_tags, '{}'),
    metadata_updated_at = now(),
    updated_at = now()
  where id = episode.id
  returning * into episode;

  return episode;
end;
$$;

revoke all on function public.claim_episode_media(text, timestamptz, date, boolean, boolean, uuid)
  from public, anon, authenticated;
revoke all on function public.save_episode_metadata(text, timestamptz, date, text, text[])
  from public, anon, authenticated;
grant execute on function public.claim_episode_media(text, timestamptz, date, boolean, boolean, uuid)
  to service_role;
grant execute on function public.save_episode_metadata(text, timestamptz, date, text, text[])
  to service_role;
