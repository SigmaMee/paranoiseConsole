alter table public.episodes
  add column if not exists published_at timestamptz,
  add column if not exists archived_at timestamptz;

create or replace function public.enforce_episode_lifecycle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and (old.published_at is not null or old.archived_at is not null) then
    if new.description is distinct from old.description
      or new.tags is distinct from old.tags
      or new.audio_filename is distinct from old.audio_filename
      or new.image_filename is distinct from old.image_filename
      or new.image_object_key is distinct from old.image_object_key
      or new.audio_submitted_at is distinct from old.audio_submitted_at
      or new.image_submitted_at is distinct from old.image_submitted_at then
      raise exception 'This episode is published or archived and its content is locked.' using errcode = '23505';
    end if;

    if (old.published_at is not null and new.published_at is distinct from old.published_at)
      or (old.archived_at is not null and new.archived_at is distinct from old.archived_at) then
      raise exception 'A published or archived episode lifecycle cannot be changed.' using errcode = '23505';
    end if;
  end if;

  if (new.published_at is not null or new.archived_at is not null)
    and new.audio_submitted_at is null then
    raise exception 'An episode without submitted audio cannot be published or archived.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_episode_lifecycle on public.episodes;
create trigger enforce_episode_lifecycle
before insert or update on public.episodes
for each row execute function public.enforce_episode_lifecycle();

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

  if episode.published_at is not null or episode.archived_at is not null then
    raise exception 'This episode is published or archived and its content is locked.' using errcode = '23505';
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

  if episode.published_at is not null or episode.archived_at is not null then
    raise exception 'This episode is published or archived and its content is locked.' using errcode = '23505';
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
declare
  episode public.episodes;
begin
  select * into episode
  from public.episodes
  where audio_claim_token = requested_claim_token
     or image_claim_token = requested_claim_token
  for update;

  if episode.id is null then
    raise exception 'Episode media claim was not found.' using errcode = 'P0002';
  end if;

  if episode.published_at is not null or episode.archived_at is not null then
    raise exception 'This episode is published or archived and its content is locked.' using errcode = '23505';
  end if;

  update public.episodes
  set
    audio_filename = case
      when requested_audio_success and audio_claim_token = requested_claim_token
        then nullif(requested_audio_filename, '')
      else audio_filename
    end,
    audio_submitted_at = case
      when requested_audio_success and audio_claim_token = requested_claim_token then now()
      else audio_submitted_at
    end,
    image_filename = case
      when requested_image_success and image_claim_token = requested_claim_token
        then nullif(requested_image_filename, '')
      else image_filename
    end,
    image_object_key = case
      when requested_image_success and image_claim_token = requested_claim_token
        then requested_image_object_key
      else image_object_key
    end,
    image_submitted_at = case
      when requested_image_success and image_claim_token = requested_claim_token then now()
      else image_submitted_at
    end,
    audio_claim_token = case when audio_claim_token = requested_claim_token then null else audio_claim_token end,
    audio_claimed_at = case when audio_claim_token = requested_claim_token then null else audio_claimed_at end,
    image_claim_token = case when image_claim_token = requested_claim_token then null else image_claim_token end,
    image_claimed_at = case when image_claim_token = requested_claim_token then null else image_claimed_at end,
    completed_at = case
      when (audio_submitted_at is not null or (requested_audio_success and audio_claim_token = requested_claim_token))
      and (image_submitted_at is not null or (requested_image_success and image_claim_token = requested_claim_token))
      then coalesce(completed_at, now())
      else completed_at
    end,
    updated_at = now()
  where id = episode.id
  returning * into episode;

  return episode;
end;
$$;

create or replace function public.mark_episode_published(
  requested_producer_email text,
  requested_show_start_at timestamptz,
  requested_airing_date date
)
returns public.episodes
language plpgsql
security definer
set search_path = public
as $$
declare
  episode public.episodes;
begin
  select * into episode
  from public.episodes
  where lower(producer_email) = lower(requested_producer_email)
    and (show_start_at = requested_show_start_at or (requested_show_start_at is null and airing_date = requested_airing_date))
  for update;

  if episode.id is null then
    raise exception 'Episode was not found.' using errcode = 'P0002';
  end if;
  if episode.audio_submitted_at is null then
    raise exception 'An episode without submitted audio cannot be published.' using errcode = '23514';
  end if;

  update public.episodes
  set published_at = coalesce(published_at, now()), updated_at = now()
  where id = episode.id
  returning * into episode;
  return episode;
end;
$$;

create or replace function public.mark_episode_archived(
  requested_producer_email text,
  requested_airing_date date
)
returns public.episodes
language plpgsql
security definer
set search_path = public
as $$
declare
  episode public.episodes;
begin
  select * into episode
  from public.episodes
  where lower(producer_email) = lower(requested_producer_email)
    and airing_date = requested_airing_date
  for update;

  if episode.id is null then
    raise exception 'Episode was not found.' using errcode = 'P0002';
  end if;
  if episode.audio_submitted_at is null then
    raise exception 'An episode without submitted audio cannot be archived.' using errcode = '23514';
  end if;

  update public.episodes
  set archived_at = coalesce(archived_at, now()), updated_at = now()
  where id = episode.id
  returning * into episode;
  return episode;
end;
$$;

revoke all on function public.enforce_episode_lifecycle() from public, anon, authenticated;
revoke all on function public.claim_episode_media(text, timestamptz, date, boolean, boolean, uuid) from public, anon, authenticated;
revoke all on function public.save_episode_metadata(text, timestamptz, date, text, text[]) from public, anon, authenticated;
revoke all on function public.finalize_episode_media(uuid, text, text, text, boolean, boolean) from public, anon, authenticated;
revoke all on function public.mark_episode_published(text, timestamptz, date) from public, anon, authenticated;
revoke all on function public.mark_episode_archived(text, date) from public, anon, authenticated;
grant execute on function public.claim_episode_media(text, timestamptz, date, boolean, boolean, uuid) to service_role;
grant execute on function public.save_episode_metadata(text, timestamptz, date, text, text[]) to service_role;
grant execute on function public.finalize_episode_media(uuid, text, text, text, boolean, boolean) to service_role;
grant execute on function public.mark_episode_published(text, timestamptz, date) to service_role;
grant execute on function public.mark_episode_archived(text, date) to service_role;
