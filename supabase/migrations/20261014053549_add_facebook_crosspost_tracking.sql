alter table public.instagram_publications
  add column if not exists facebook_status text not null default 'not_requested',
  add column if not exists facebook_post_id text,
  add column if not exists facebook_error_message text,
  add column if not exists facebook_published_at timestamptz;

alter table public.instagram_publications
  drop constraint if exists instagram_publications_facebook_status_check;

alter table public.instagram_publications
  add constraint instagram_publications_facebook_status_check
  check (facebook_status in ('not_requested', 'pending', 'publishing', 'published', 'failed'));

create unique index if not exists instagram_publications_facebook_post_id_idx
  on public.instagram_publications (facebook_post_id)
  where facebook_post_id is not null;

comment on column public.instagram_publications.facebook_status is
  'Tracks automatic Facebook Page mirroring independently from Instagram publication status.';
