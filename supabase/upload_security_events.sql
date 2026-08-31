create table if not exists public.upload_security_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  trace_id text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  event_type text not null check (
    event_type in ('presign_issued', 'delivery_attempted', 'delivery_completed')
  ),
  outcome text not null check (
    outcome in ('accepted', 'pending', 'success', 'partial', 'failed')
  ),
  upload_type text,
  staged_object_keys text[] not null default '{}',
  audio_filename text,
  image_filename text,
  target_producer_folder text,
  details jsonb not null default '{}'::jsonb
);

create index if not exists upload_security_events_created_at_idx
  on public.upload_security_events (created_at desc);

create index if not exists upload_security_events_trace_id_idx
  on public.upload_security_events (trace_id);

create index if not exists upload_security_events_actor_email_idx
  on public.upload_security_events (actor_email, created_at desc);

alter table public.upload_security_events enable row level security;

revoke all on table public.upload_security_events from anon, authenticated;
grant select, insert on table public.upload_security_events to service_role;
