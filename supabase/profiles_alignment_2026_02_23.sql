begin;

-- Rename existing producer names to match FTP naming.
update public.profiles p
set full_name = 'Node'
where p.full_name = 'Node (Gated Recordings)'
  and not exists (
    select 1
    from public.profiles p2
    where p2.full_name = 'Node'
      and p2.id <> p.id
  );

update public.profiles p
set full_name = 'Ntavisia'
where p.full_name = 'Ntavisia Brave'
  and not exists (
    select 1
    from public.profiles p2
    where p2.full_name = 'Ntavisia'
      and p2.id <> p.id
  );

update public.profiles p
set full_name = 'Hexae'
where p.full_name = 'Hexæ'
  and not exists (
    select 1
    from public.profiles p2
    where p2.full_name = 'Hexae'
      and p2.id <> p.id
  );

update public.profiles p
set full_name = 'Illian'
where p.full_name = 'Ilian'
  and not exists (
    select 1
    from public.profiles p2
    where p2.full_name = 'Illian'
      and p2.id <> p.id
  );

-- Insert missing producers (or update name if email already exists).
insert into public.profiles (producer_email, full_name)
values ('fkarapatsios@gmail.com', 'Phi Kapa')
on conflict (producer_email)
do update set full_name = excluded.full_name, updated_at = now();

insert into public.profiles (producer_email, full_name)
values ('intarunner@yahoo.com', 'Runner')
on conflict (producer_email)
do update set full_name = excluded.full_name, updated_at = now();

insert into public.profiles (producer_email, full_name)
values ('rom.pap@gmail.com', 'SPREY')
on conflict (producer_email)
do update set full_name = excluded.full_name, updated_at = now();

insert into public.profiles (producer_email, full_name)
values ('spyreytos@gmail.com', 'Yardy')
on conflict (producer_email)
do update set full_name = excluded.full_name, updated_at = now();

commit;
