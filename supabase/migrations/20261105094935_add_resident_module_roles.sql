alter table public.resident_profiles
  add column if not exists roles text[] not null default array['production']::text[];

update public.resident_profiles
set roles = array['production']::text[]
where roles is null or cardinality(roles) = 0;

alter table public.resident_profiles
  drop constraint if exists resident_profiles_roles_check;
alter table public.resident_profiles
  add constraint resident_profiles_roles_check check (
    roles @> array['production']::text[]
    and roles <@ array['production', 'sharing']::text[]
  );

comment on column public.resident_profiles.roles is
  'Console module roles. Production is required; sharing grants the complete ON AIR workflow.';
