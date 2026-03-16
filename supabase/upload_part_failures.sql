create table if not exists public.upload_part_failures (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid,
  user_email text,
  object_key text,
  upload_id text,
  part_number int,
  attempt int,
  field text,
  file_name text,
  file_size bigint,
  chunk_size bigint,
  status_code int,
  message text,
  response_body text
);

create index if not exists upload_part_failures_created_at_idx
  on public.upload_part_failures (created_at desc);

create index if not exists upload_part_failures_user_email_idx
  on public.upload_part_failures (user_email);
