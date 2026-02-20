create table if not exists public.submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  producer_email text not null,
  title text not null,
  audio_filename text not null,
  image_filename text not null,
  ftp_status text not null,
  drive_status text not null,
  ftp_message text not null,
  drive_message text not null
);

create index if not exists submissions_created_at_idx
  on public.submissions (created_at desc);

create index if not exists submissions_producer_email_idx
  on public.submissions (producer_email);

alter table public.submissions enable row level security;

drop policy if exists submissions_select_own on public.submissions;
create policy submissions_select_own on public.submissions
for select
using (
  lower(producer_email) = lower(coalesce(auth.jwt()->>'email', ''))
);
