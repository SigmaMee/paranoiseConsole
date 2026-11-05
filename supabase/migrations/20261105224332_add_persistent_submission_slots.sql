create table if not exists public.submission_slots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  producer_email text not null,
  show_start_at timestamptz not null,
  airing_date date not null,
  audio_filename text,
  image_filename text,
  image_object_key text,
  audio_submitted_at timestamptz,
  image_submitted_at timestamptz,
  completed_at timestamptz,
  audio_claim_token uuid,
  image_claim_token uuid,
  audio_claimed_at timestamptz,
  image_claimed_at timestamptz
);

create unique index if not exists submission_slots_resident_show_idx
  on public.submission_slots (lower(producer_email), show_start_at);

create index if not exists submission_slots_airing_date_idx
  on public.submission_slots (airing_date);

insert into public.submission_slots (
  producer_email,
  show_start_at,
  airing_date,
  audio_filename,
  image_filename,
  image_object_key,
  audio_submitted_at,
  image_submitted_at,
  completed_at
)
select
  lower(producer_email),
  coalesce(max(show_start_at), airing_date::timestamptz),
  airing_date,
  max(nullif(audio_filename, '')) filter (where ftp_status = 'success'),
  max(nullif(image_filename, '')) filter (where ftp_status = 'success' and drive_status = 'success'),
  max(image_object_key) filter (
    where nullif(image_filename, '') is not null
      and ftp_status = 'success'
      and drive_status = 'success'
  ),
  min(created_at) filter (where nullif(audio_filename, '') is not null and ftp_status = 'success'),
  min(created_at) filter (
    where nullif(image_filename, '') is not null
      and ftp_status = 'success'
      and drive_status = 'success'
  ),
  case
    when bool_or(nullif(audio_filename, '') is not null and ftp_status = 'success')
      and bool_or(
        nullif(image_filename, '') is not null
        and ftp_status = 'success'
        and drive_status = 'success'
      )
    then max(created_at)
    else null
  end
from public.submissions
where airing_date is not null
group by lower(producer_email), airing_date
on conflict do nothing;

alter table public.submission_slots enable row level security;

revoke all on table public.submission_slots from anon;
revoke all on table public.submission_slots from authenticated;
grant select on table public.submission_slots to authenticated;

drop policy if exists submission_slots_select_own on public.submission_slots;
create policy submission_slots_select_own on public.submission_slots
for select
to authenticated
using (lower(producer_email) = lower(coalesce((select auth.jwt())->>'email', '')));

create or replace function public.claim_submission_slot_media(
  requested_producer_email text,
  requested_show_start_at timestamptz,
  requested_airing_date date,
  requested_audio boolean,
  requested_image boolean,
  requested_claim_token uuid
)
returns public.submission_slots
language plpgsql
security definer
set search_path = public
as $$
declare
  slot public.submission_slots;
  stale_before timestamptz := now() - interval '1 hour';
begin
  if not requested_audio and not requested_image then
    raise exception 'At least one media component must be claimed.' using errcode = '22023';
  end if;

  insert into public.submission_slots (
    producer_email,
    show_start_at,
    airing_date
  ) values (
    lower(requested_producer_email),
    requested_show_start_at,
    requested_airing_date
  )
  on conflict do nothing;

  select * into slot
  from public.submission_slots
  where lower(producer_email) = lower(requested_producer_email)
    and show_start_at = requested_show_start_at
  for update;

  if slot.completed_at is not null then
    raise exception 'This show submission is already complete.' using errcode = '23505';
  end if;

  if requested_audio and (
    slot.audio_submitted_at is not null
    or (slot.audio_claim_token is not null and slot.audio_claimed_at >= stale_before)
  ) then
    raise exception 'Audio has already been submitted or is being submitted.' using errcode = '23505';
  end if;

  if requested_image and (
    slot.image_submitted_at is not null
    or (slot.image_claim_token is not null and slot.image_claimed_at >= stale_before)
  ) then
    raise exception 'Artwork has already been submitted or is being submitted.' using errcode = '23505';
  end if;

  update public.submission_slots
  set
    audio_claim_token = case when requested_audio then requested_claim_token else audio_claim_token end,
    audio_claimed_at = case when requested_audio then now() else audio_claimed_at end,
    image_claim_token = case when requested_image then requested_claim_token else image_claim_token end,
    image_claimed_at = case when requested_image then now() else image_claimed_at end,
    updated_at = now()
  where id = slot.id
  returning * into slot;

  return slot;
end;
$$;

create or replace function public.finalize_submission_slot_media(
  requested_claim_token uuid,
  requested_audio_filename text,
  requested_image_filename text,
  requested_image_object_key text,
  requested_audio_success boolean,
  requested_image_success boolean
)
returns public.submission_slots
language plpgsql
security definer
set search_path = public
as $$
declare
  slot public.submission_slots;
begin
  select * into slot
  from public.submission_slots
  where audio_claim_token = requested_claim_token
     or image_claim_token = requested_claim_token
  for update;

  if slot.id is null then
    raise exception 'Submission media claim was not found.' using errcode = 'P0002';
  end if;

  update public.submission_slots
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
    updated_at = now()
  where id = slot.id
  returning * into slot;

  if slot.audio_submitted_at is not null
    and slot.image_submitted_at is not null
    and slot.completed_at is null then
    update public.submission_slots
    set completed_at = now(), updated_at = now()
    where id = slot.id
    returning * into slot;
  end if;

  return slot;
end;
$$;

revoke all on function public.claim_submission_slot_media(text, timestamptz, date, boolean, boolean, uuid) from public;
revoke all on function public.finalize_submission_slot_media(uuid, text, text, text, boolean, boolean) from public;
revoke all on function public.claim_submission_slot_media(text, timestamptz, date, boolean, boolean, uuid) from anon;
revoke all on function public.finalize_submission_slot_media(uuid, text, text, text, boolean, boolean) from anon;
revoke all on function public.claim_submission_slot_media(text, timestamptz, date, boolean, boolean, uuid) from authenticated;
revoke all on function public.finalize_submission_slot_media(uuid, text, text, text, boolean, boolean) from authenticated;
grant execute on function public.claim_submission_slot_media(text, timestamptz, date, boolean, boolean, uuid) to service_role;
grant execute on function public.finalize_submission_slot_media(uuid, text, text, text, boolean, boolean) to service_role;
