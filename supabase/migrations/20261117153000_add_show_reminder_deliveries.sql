create table if not exists public.show_reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  calendar_event_id text not null,
  producer_email text not null,
  recipient_email text not null,
  show_title text not null,
  show_start_at timestamptz not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  delivery_status text not null check (delivery_status in ('pending', 'sent', 'failed')),
  sent_at timestamptz,
  used_at timestamptz,
  error_message text
);

create unique index if not exists show_reminder_resident_occurrence_idx
  on public.show_reminder_deliveries (calendar_event_id, lower(producer_email));

alter table public.show_reminder_deliveries enable row level security;
revoke all on table public.show_reminder_deliveries from anon, authenticated;

comment on table public.show_reminder_deliveries is
  'Server-only reminder delivery and hashed direct-access credentials for show occurrences.';
