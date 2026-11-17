create table if not exists public.show_cancellation_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  calendar_event_id text not null,
  recurring_event_id text,
  producer_email text not null,
  actor_email text not null,
  show_start_at timestamptz,
  show_title text,
  outcome text not null check (outcome in ('cancelled', 'rejected', 'error')),
  error_message text
);

create index if not exists show_cancellation_event_lookup_idx
  on public.show_cancellation_events (calendar_event_id, lower(producer_email), outcome);

alter table public.show_cancellation_events enable row level security;
revoke all on table public.show_cancellation_events from anon, authenticated;

comment on table public.show_cancellation_events is
  'Server-only audit trail for resident Google Calendar occurrence cancellation attempts.';
