begin;

alter table public.profiles
  add column if not exists webflow_item_id text;

create index if not exists profiles_webflow_item_id_idx
  on public.profiles (webflow_item_id)
  where webflow_item_id is not null;

alter table public.submissions
  add column if not exists mixcloud_key text,
  add column if not exists mixcloud_url text,
  add column if not exists webflow_status text not null default 'not ready',
  add column if not exists webflow_item_id text,
  add column if not exists webflow_error text,
  add column if not exists webflow_published_at timestamptz;

alter table public.submissions
  drop constraint if exists submissions_webflow_status_check;

alter table public.submissions
  add constraint submissions_webflow_status_check
  check (webflow_status in ('not ready', 'ready', 'publishing', 'published', 'failed'));

update public.submissions
set webflow_status = 'ready'
where mixcloud = 'published'
  and webflow_status = 'not ready';

commit;
