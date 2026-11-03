# Resident slug rollout

Console owns the canonical resident slug. Existing FTP folders and Centova
playlists keep their current names until the alignment audit confirms they are
ready for a later cutover.

## Deployment order

1. Apply `supabase/migrations/20261103103754_add_resident_routing_identifiers.sql`.
   The new columns are nullable and do not change existing routes.
2. Run `npm run backfill:resident-slugs` to preserve established Webflow
   resident slugs in Console. Existing Console slugs are never overwritten.
3. Deploy the compatible application code. Profiles without explicit routing
   names continue to use `full_name`; newly imported residents use their slug.
4. Run `npm run audit:resident-routing`. Resolve any current-route failures
   before considering external resource changes.

## Not part of this phase

- Renaming existing FTP folders.
- Renaming existing Centova playlists.
- Making slug columns required.
- Removing the `full_name` routing fallback.

Those changes require a clean alignment report and a separately reviewed
production change.
