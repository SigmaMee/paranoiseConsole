revoke all on function public.claim_submission_slot_media(text, timestamptz, date, boolean, boolean, uuid) from public;
revoke all on function public.finalize_submission_slot_media(uuid, text, text, text, boolean, boolean) from public;
revoke all on function public.claim_submission_slot_media(text, timestamptz, date, boolean, boolean, uuid) from anon;
revoke all on function public.finalize_submission_slot_media(uuid, text, text, text, boolean, boolean) from anon;
revoke all on function public.claim_submission_slot_media(text, timestamptz, date, boolean, boolean, uuid) from authenticated;
revoke all on function public.finalize_submission_slot_media(uuid, text, text, text, boolean, boolean) from authenticated;
grant execute on function public.claim_submission_slot_media(text, timestamptz, date, boolean, boolean, uuid) to service_role;
grant execute on function public.finalize_submission_slot_media(uuid, text, text, text, boolean, boolean) to service_role;
