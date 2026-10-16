alter table if exists public.submissions
  add column if not exists audio_object_key text,
  add column if not exists mixcloud_workflow_run_id text,
  add column if not exists mixcloud_started_at timestamptz,
  add column if not exists mixcloud_published_at timestamptz,
  add column if not exists r2_audio_deleted_at timestamptz;

create index if not exists submissions_mixcloud_workflow_run_id_idx
  on public.submissions (mixcloud_workflow_run_id)
  where mixcloud_workflow_run_id is not null;
