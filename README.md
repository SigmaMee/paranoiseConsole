# Paranoise Console App

Next.js + Supabase starter for the Console MVP.

## Current Foundation
- App Router with TypeScript
- Supabase auth (email + password)
- Protected dashboard route
- Middleware session refresh

## Setup
1. Copy env template:
	- `cp .env.example .env.local`
2. Fill `.env.local`:
	- `NEXT_PUBLIC_SUPABASE_URL`
	- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
	- `SUPABASE_SERVICE_ROLE_KEY`
	- `GOOGLE_CALENDAR_ID`
	- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
	- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (use escaped newlines: `\\n`)
	- `GOOGLE_DRIVE_FOLDER_ID`
	- `FTP_HOST`
	- `FTP_USER`
	- `FTP_PASSWORD`
	- `FTP_SECURE` (`true` or `false`)
	- `FTP_PRODUCER_ROOT_DIR` (for your setup use `media`)
3. Ensure producer users are pre-created in Supabase Auth.
4. Share your Google Calendar with the service account email with at least "See all event details" permission.
5. Create the status table in Supabase SQL editor using `supabase/submissions.sql`.
6. Create profile staging tables in Supabase SQL editor using `supabase/profiles.sql`.

## FTP Producer Folder Routing
- Console routes audio to `FTP_PRODUCER_ROOT_DIR/{producer_full_name}`.
- `producer_full_name` is read from Supabase `profiles.full_name` for the signed-in `producer_email`.
- If the target producer folder does not exist, upload fails (no auto-create).
- With your FTP structure, this resolves to `media/{producer_full_name}`.

## Profile Staging Layer (Supabase -> Webflow)
- Producer profile drafts are stored in Supabase (`profiles` table).
- Every profile save enqueues a `profile_sync_jobs` row with `pending` status.
- This keeps Supabase as staging only while Webflow remains publish/review destination.

## Import Existing Profiles from Webflow Export
1. Export producer data from Webflow into CSV (or JSON if you already have it).
2. Ensure each record includes at least:
	- `name` (Webflow `Name` column)
3. Set `WEBFLOW_EXPORT_PATH` in `.env.local`.
4. Run:
	- `npm run import:profiles`

Supported optional fields in import CSV/JSON:
- `bio`
- `location`
- `avatar_url` (or `image`)
- `social_url` (or `link`)
- `webflow_item_id` (or `id`)

CSV notes:
- Header names are normalized to snake_case automatically.
- Example compatible headers: `Email`, `Full Name`, `Bio`, `Location`, `Avatar URL`, `Social URL`.
- If `Email` is missing, importer generates placeholder `pending+{slug}@paranoise.local` and you can update `producer_email` manually in Supabase.
- `Slug` is stored as `webflow_item_id` for reference.

## Run
```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Routes
- `/login`: producer sign-in
- `/dashboard`: protected page (signed-in users only)

## Next Build Work (from backlog)
- B-1: Google Calendar producer feed
- C-0/C-1/C-2/C-6: combined submission form + validation
- C-3/C-4/C-5: FTP/Drive routing + status
- D-1/D-2/D-3: profile draft + Webflow sync flow
