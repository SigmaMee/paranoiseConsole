alter table if exists public.submissions
  add column if not exists producer_profile_id uuid references public.profiles(id) on delete set null;

create index if not exists submissions_producer_profile_id_idx
  on public.submissions (producer_profile_id);

update public.submissions s
set producer_profile_id = p.id
from public.profiles p
where s.producer_profile_id is null
  and lower(s.producer_email) = lower(p.producer_email);
