alter table if exists public.submissions
  add column if not exists image_object_key text;

comment on column public.submissions.image_object_key is
  'Private Cloudflare R2 object key for the permanently retained cover image.';
