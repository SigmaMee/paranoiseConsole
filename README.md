# Paranoise Console

Console is a production-facing internal tool for managing radio show submissions end to end. It gives resident producers of [Paranoise Radio](https://www.paranoiseradio.com) a focused workflow for uploading audio, cover art, description copy, and genre metadata, while giving admins a clear operational view of schedule coverage, account alignment, and media delivery across external systems.

Console solves a real coordination problem across content, scheduling, storage, authentication, and delivery.

## Overview

The console sits between the weekly radio schedule and the broadcast/archive stack.

- Producers sign in and submit assets for an upcoming show.
- Audio and cover files upload directly to Cloudflare R2 using presigned URLs.
- The server validates metadata and routes files to downstream systems.
- Audio is delivered to producer-specific FTP folders.
- Cover art is delivered to Google Drive using OAuth or service-account access.
- Mixcloud publishing can be triggered when credentials are available.
- Admins monitor submission coverage, sync users from Google Calendar, and review operational activity.

## Features

- Multi-system orchestration across Supabase, Google Calendar, Google Drive, Cloudflare R2, FTP, Mixcloud, Resend, and Vercel.
- Large-file upload handling with multipart support, retry logic, adaptive fallback, and telemetry.
- Clear separation between client-side staging uploads and server-side routing/processing.
- Admin tooling for schedule-aware onboarding and reporting, instead of treating operations as manual back-office work.
- Product thinking in the UI: direct uploads, drag and drop, preview states, progress feedback, and partial-failure reporting.
- Auto-generated daily reports of submissions and schedule status delivered via mail.

## Core Workflows

### 1. Producer Submission Flow

Residents authenticate through Supabase and land on a protected dashboard. From there they can upload:

- MP3 audio up to 500 MB
- square cover art
- show description
- up to 5 genre tags

The submission form supports drag and drop, image preview, audio preview, waveform scrubbing, and staged progress states. Files are uploaded directly from the browser to R2, then the app sends a smaller metadata payload to the server so Vercel never has to accept the full media payload.

### 2. Media Routing Flow

Once upload staging completes, the app:

- resolves the producer’s target FTP folder from the profile record
- downloads staged files from R2
- pushes audio to FTP
- pushes cover art to Google Drive
- optionally publishes to Mixcloud
- persists submission metadata and delivery status in Supabase
- sends a confirmation email

The routing layer reports partial failures cleanly, which matters when different external systems succeed or fail independently.

### 3. Admin Operations Flow

Admins can:

- view upcoming and recent shows sourced from Google Calendar
- measure schedule coverage against actual submissions
- inspect activity logs and media state
- bulk-create producer auth accounts from calendar attendees
- detect profile drift between identity and profile data

This turns the app into an operations console, not just an uploader.

## Architecture

```text
Producer UI
  -> direct upload to Cloudflare R2 via presigned URLs
  -> metadata POST to Next.js API
  -> validation + routing layer
  -> FTP / Google Drive / Mixcloud
  -> Supabase persistence + Resend notifications

Admin UI
  -> Supabase + Google Calendar aggregation
  -> activity, sync, and reporting tools
```

## Notable Engineering Decisions

### Direct-to-storage uploads

Large media files do not pass through the application server. The client requests presigned upload descriptors, uploads directly to R2, then submits only object keys and metadata to the API.

Why it matters:

- reduces server load
- avoids request-size bottlenecks
- improves reliability for media workflows on serverless infrastructure

### Multipart upload with adaptive fallback

The audio pipeline uses multipart uploads with retries and timeout-aware fallback behavior. If a large upload fails in the primary mode because of timeout-like conditions, the client requests a new adaptive presign configuration and retries with smaller parts and lower concurrency.

Why it matters:

- better resilience on unstable networks
- fewer failed long-running uploads
- concrete operational telemetry for debugging failed chunks

### Partial-failure aware submission handling

External destinations can fail independently. The submission flow treats that as an explicit system state rather than collapsing everything into a generic success/failure result.

Why it matters:

- better operator visibility
- clearer recovery paths
- more honest UX for production operations

### Calendar-driven onboarding

Google Calendar acts as a source of truth for upcoming shows and producer presence. Admin tooling can scan events, identify producers, and create missing auth users in bulk.

Why it matters:

- reduces manual user provisioning
- keeps access aligned with the schedule
- connects programming operations with platform access

## Stack

### Frontend

- Next.js 16 App Router
- React 19
- TypeScript

### Backend and data

- Next.js route handlers
- Supabase Auth + Postgres
- Cloudflare R2 via AWS SDK S3-compatible APIs

### Integrations

- Google Calendar API
- Google Drive API
- Mixcloud OAuth/API
- FTP via basic-ftp
- Resend for transactional email
- Centova integration for playlist/reporting workflows

### Deployment

- Vercel

## Repository Highlights

- [src/components/submission-form.tsx](src/components/submission-form.tsx): producer-facing upload UX, multipart logic, progress states, and client-side validation.
- [src/app/api/submissions/route.ts](src/app/api/submissions/route.ts): core submission orchestration and downstream delivery.
- [src/app/api/submissions/presign/route.ts](src/app/api/submissions/presign/route.ts): presigned upload generation for direct-to-R2 transfers.
- [src/app/dashboard/page.tsx](src/app/dashboard/page.tsx): protected admin/producer dashboard with schedule and activity insights.
- [src/lib/calendar-user-sync.ts](src/lib/calendar-user-sync.ts): Google Calendar driven onboarding workflow.
- [src/app/api/cron/daily-report/route.ts](src/app/api/cron/daily-report/route.ts): scheduled reporting for next-day schedule readiness.

## Local Development

### Requirements

- Node.js 20.x
- npm
- Supabase project with Auth and the required tables
- Access to the external services used by the app

### Install

```bash
npm install
npm run dev
```

App URL:

```text
http://localhost:3000
```

### Environment Variables

Create `.env.local` and define the values your environment needs.

Core app:

- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Cloudflare R2:

- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

Google Calendar and Drive:

- `GOOGLE_CALENDAR_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` using escaped newlines as `\\n`
- `GOOGLE_DRIVE_FOLDER_ID`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_DRIVE_ALLOW_SERVICE_ACCOUNT_FALLBACK`

FTP:

- `FTP_HOST`
- `FTP_USER`
- `FTP_PASSWORD`
- `FTP_SECURE`
- `FTP_PRODUCER_ROOT_DIR`

Mixcloud and email:

- `MIXCLOUD_CLIENT_ID`
- `MIXCLOUD_CLIENT_SECRET`
- `MIXCLOUD_OAUTH_REDIRECT_URI`
- `RESEND_API_KEY`

Ops and cron:

- `ADMIN_EMAIL`
- `CRON_SECRET`

Optional data import:

- `WEBFLOW_EXPORT_PATH`

## Data and Infrastructure Notes

### FTP routing

- Audio is routed to `FTP_PRODUCER_ROOT_DIR/{producer_full_name}`.
- `producer_full_name` is resolved from the signed-in producer’s profile.
- Producer folders are expected to exist already. The app does not auto-create them.

### Google Drive delivery

- Cover art can be uploaded via a connected OAuth token or a service account.
- Service-account uploads require access to a Shared Drive or accessible folder.
- If OAuth becomes invalid, fallback behavior can be controlled with `GOOGLE_DRIVE_ALLOW_SERVICE_ACCOUNT_FALLBACK`.

### Profile staging

- Producer profile drafts live in Supabase.
- Profile saves enqueue sync jobs so Supabase can act as a staging layer while another CMS remains the publishing destination.



## Deployment Notes

- Deploy target: Vercel
- Build command: `npm run build`
- Start command: `npm run start`
- The submissions API runs on the Node.js runtime and is configured for long-running processing.
- Direct-to-R2 uploads reduce pressure on Vercel limits, but downstream processing time still needs to fit the deployment plan and runtime budget.

## Routes

- `/login` for producer sign-in
- `/dashboard` for the protected producer/admin console

## Summary

Paranoise Console demonstrates the kind of engineering that matters in production internal tools: coordinating multiple third-party systems, handling large-file uploads reliably, designing around serverless constraints, and giving operators enough visibility to trust the workflow.
