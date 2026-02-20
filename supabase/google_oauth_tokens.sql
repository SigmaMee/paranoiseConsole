create table if not exists public.google_oauth_tokens (
  provider text primary key,
  refresh_token text not null,
  scope text,
  token_type text,
  expiry_date bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_email text
);

create or replace function public.set_updated_at_google_oauth_tokens()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_google_oauth_tokens_updated_at on public.google_oauth_tokens;
create trigger trg_google_oauth_tokens_updated_at
before update on public.google_oauth_tokens
for each row
execute procedure public.set_updated_at_google_oauth_tokens();

alter table public.google_oauth_tokens enable row level security;
