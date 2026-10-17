create table if not exists public.resident_profiles (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.profiles(id) on delete set null,
  producer_name text not null,
  radio_show text,
  city text,
  show_type text not null default 'Recorded',
  about text,
  follow_link text,
  profile_picture_path text,
  profile_picture_alt text,
  source_profile_picture_url text,
  webflow_item_id text unique,
  webflow_sync_status text not null default 'pending',
  webflow_last_synced_at timestamptz,
  webflow_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resident_profiles_show_type_check
    check (show_type in ('Recorded', 'Live')),
  constraint resident_profiles_webflow_sync_status_check
    check (webflow_sync_status in ('pending', 'synced', 'failed'))
);

create index if not exists resident_profiles_producer_name_idx
  on public.resident_profiles (lower(producer_name));

drop trigger if exists resident_profiles_set_updated_at on public.resident_profiles;
create trigger resident_profiles_set_updated_at
before update on public.resident_profiles
for each row execute function public.set_updated_at();

alter table public.resident_profiles enable row level security;

-- Resident administration is server-only. No Data API policies are granted here;
-- trusted server clients use the service role and the future Save endpoint must
-- independently enforce the sole-administrator rule.
revoke all on table public.resident_profiles from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'resident-profile-pictures',
  'resident-profile-pictures',
  true,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

comment on table public.resident_profiles is
  'Authoritative resident profile data. Webflow is a downstream publishing endpoint.';
comment on column public.resident_profiles.source_profile_picture_url is
  'Original Webflow image URL retained only for migration provenance and audit.';
comment on column public.resident_profiles.webflow_sync_status is
  'Whether the authoritative Supabase row has been delivered to Webflow.';
