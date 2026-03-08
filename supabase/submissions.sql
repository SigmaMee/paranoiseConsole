create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  producer_profile_id uuid references public.profiles(id) on delete set null,
  producer_email text not null,
  audio_filename text not null,
  image_filename text not null,
  show_start_at timestamptz,
  airing_date date,
  submitted_description text,
  submitted_tags text[],
  ftp_status text not null,
  drive_status text not null,
  ftp_message text not null,
  drive_message text not null
);

alter table if exists public.submissions
  add column if not exists producer_profile_id uuid references public.profiles(id) on delete set null;

alter table if exists public.submissions
  add column if not exists show_start_at timestamptz;

alter table if exists public.submissions
  add column if not exists airing_date date;

alter table if exists public.submissions
  add column if not exists submitted_description text;

alter table if exists public.submissions
  add column if not exists submitted_tags text[];

create index if not exists submissions_created_at_idx
  on public.submissions (created_at desc);

create index if not exists submissions_producer_email_idx
  on public.submissions (producer_email);

create index if not exists submissions_producer_profile_id_idx
  on public.submissions (producer_profile_id);

create index if not exists submissions_airing_date_idx
  on public.submissions (airing_date);

create index if not exists submissions_submitted_tags_gin_idx
  on public.submissions using gin (submitted_tags);

alter table public.submissions enable row level security;

drop policy if exists submissions_select_own on public.submissions;
create policy submissions_select_own on public.submissions
for select
using (
  lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
);

alter table if exists public.submissions
  drop column if exists title;
