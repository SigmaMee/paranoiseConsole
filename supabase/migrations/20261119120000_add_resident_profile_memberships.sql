create table if not exists public.resident_profile_memberships (
  resident_profile_id uuid not null references public.resident_profiles(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (resident_profile_id, profile_id),
  constraint resident_profile_memberships_profile_id_key unique (profile_id)
);

comment on table public.resident_profile_memberships is
  'Temporary many-to-one link allowing multiple producer profiles to administer one resident/show profile.';

alter table public.resident_profile_memberships enable row level security;
revoke all on table public.resident_profile_memberships from anon, authenticated;

-- Preserve every existing primary profile link.
insert into public.resident_profile_memberships (resident_profile_id, profile_id)
select id, profile_id
from public.resident_profiles
where profile_id is not null
on conflict (profile_id) do nothing;

-- Link duplicate producer accounts that already identify the same Webflow resident.
insert into public.resident_profile_memberships (resident_profile_id, profile_id)
select resident.id, profile.id
from public.resident_profiles resident
join public.profiles profile
  on profile.webflow_item_id = resident.webflow_item_id
where resident.webflow_item_id is not null
on conflict (profile_id) do nothing;

create or replace function public.sync_primary_resident_profile_membership()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.profile_id is not null then
    insert into public.resident_profile_memberships (resident_profile_id, profile_id)
    values (new.id, new.profile_id)
    on conflict (profile_id) do update
      set resident_profile_id = excluded.resident_profile_id;
  end if;
  return new;
end;
$$;

drop trigger if exists resident_profiles_sync_primary_membership on public.resident_profiles;
create trigger resident_profiles_sync_primary_membership
after insert or update of profile_id on public.resident_profiles
for each row execute function public.sync_primary_resident_profile_membership();
