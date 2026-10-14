create table if not exists public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique check (provider in ('instagram')),
  status text not null default 'disconnected' check (status in ('connected', 'disconnected', 'revoked', 'deletion_requested')),
  external_user_id text not null,
  account_id text not null,
  account_username text,
  page_id text not null,
  page_name text,
  encrypted_access_token text,
  token_expires_at timestamptz,
  granted_scopes text[] not null default '{}',
  connected_by_user_id uuid references auth.users(id) on delete set null,
  connected_by_email text,
  connected_at timestamptz not null default now(),
  last_verified_at timestamptz,
  disconnected_at timestamptz,
  data_deletion_code text unique,
  data_deletion_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint integration_connections_token_state check (
    (status = 'connected' and encrypted_access_token is not null)
    or (status <> 'connected' and encrypted_access_token is null)
  )
);

alter table public.integration_connections enable row level security;
revoke all on table public.integration_connections from anon, authenticated;
grant select, insert, update, delete on table public.integration_connections to service_role;

comment on table public.integration_connections is
  'Server-only third-party integration metadata. Access tokens are encrypted by the application before storage.';
comment on column public.integration_connections.encrypted_access_token is
  'AES-256-GCM ciphertext; never contains a plaintext access token.';

create table if not exists public.instagram_publications (
  id uuid primary key default gen_random_uuid(),
  date_iso date not null,
  caption text not null check (char_length(caption) between 1 and 2200),
  idempotency_key text not null unique,
  status text not null check (status in ('publishing', 'published', 'failed')),
  instagram_media_id text unique,
  permalink text,
  error_message text,
  published_by_user_id uuid references auth.users(id) on delete set null,
  published_by_email text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists instagram_publications_date_iso_idx
  on public.instagram_publications (date_iso desc, created_at desc);
create index if not exists instagram_publications_published_by_user_id_idx
  on public.instagram_publications (published_by_user_id);

create table if not exists public.instagram_publication_items (
  id bigint generated always as identity primary key,
  publication_id uuid not null references public.instagram_publications(id) on delete cascade,
  submission_id uuid not null references public.submissions(id) on delete restrict,
  position smallint not null check (position between 0 and 9),
  image_object_key text not null,
  image_filename text,
  instagram_container_id text,
  created_at timestamptz not null default now(),
  unique (publication_id, position),
  unique (publication_id, submission_id)
);

create index if not exists instagram_publication_items_submission_id_idx
  on public.instagram_publication_items (submission_id);
create index if not exists integration_connections_connected_by_user_id_idx
  on public.integration_connections (connected_by_user_id);

alter table public.instagram_publications enable row level security;
alter table public.instagram_publication_items enable row level security;
revoke all on table public.instagram_publications from anon, authenticated;
revoke all on table public.instagram_publication_items from anon, authenticated;
revoke all on sequence public.instagram_publication_items_id_seq from anon, authenticated;
grant select, insert, update, delete on table public.instagram_publications to service_role;
grant select, insert, update, delete on table public.instagram_publication_items to service_role;
grant usage, select on sequence public.instagram_publication_items_id_seq to service_role;
