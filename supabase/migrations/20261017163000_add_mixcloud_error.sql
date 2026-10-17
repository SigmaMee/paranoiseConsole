alter table public.submissions
  add column if not exists mixcloud_error text;
