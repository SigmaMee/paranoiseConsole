alter table public.episodes
  add column if not exists description text not null default '',
  add column if not exists tags text[] not null default '{}',
  add column if not exists metadata_updated_at timestamptz;

with latest as (
  select distinct on (lower(submission.producer_email), submission.airing_date)
    lower(submission.producer_email) as producer_email,
    submission.airing_date,
    submission.submitted_description,
    submission.submitted_tags,
    submission.created_at
  from public.submissions submission
  order by lower(submission.producer_email), submission.airing_date, submission.created_at desc, submission.id desc
)
update public.episodes episode
set
  description = coalesce(latest.submitted_description, ''),
  tags = coalesce(latest.submitted_tags, '{}'),
  metadata_updated_at = latest.created_at
from latest
where latest.producer_email = lower(episode.producer_email)
  and latest.airing_date = episode.airing_date;

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

  if episode.completed_at is not null then
    raise exception 'This episode is complete and its content is locked.' using errcode = '23505';
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

revoke all on function public.save_episode_metadata(text, timestamptz, date, text, text[]) from public, anon, authenticated;
grant execute on function public.save_episode_metadata(text, timestamptz, date, text, text[]) to service_role;
