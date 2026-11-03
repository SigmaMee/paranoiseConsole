alter table public.profiles
  add column if not exists slug text,
  add column if not exists ftp_folder_name text,
  add column if not exists centova_playlist_name text;

alter table public.profiles
  drop constraint if exists profiles_slug_format_check;
alter table public.profiles
  add constraint profiles_slug_format_check
  check (slug is null or slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

create unique index if not exists profiles_slug_unique_idx
  on public.profiles (slug)
  where slug is not null;

alter table public.resident_profiles
  add column if not exists slug text;

alter table public.resident_profiles
  drop constraint if exists resident_profiles_slug_format_check;
alter table public.resident_profiles
  add constraint resident_profiles_slug_format_check
  check (slug is null or slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

create unique index if not exists resident_profiles_slug_unique_idx
  on public.resident_profiles (slug)
  where slug is not null;

comment on column public.profiles.slug is
  'Console-owned canonical resident identifier. Nullable during the compatibility rollout.';
comment on column public.profiles.ftp_folder_name is
  'Explicit FTP routing name. Null preserves the legacy full_name route.';
comment on column public.profiles.centova_playlist_name is
  'Explicit Centova routing name. Null preserves the legacy full_name route.';
comment on column public.resident_profiles.slug is
  'Canonical resident slug delivered to Webflow; must agree with profiles.slug when linked.';
