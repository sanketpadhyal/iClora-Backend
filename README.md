<p align="center">
  <img src="https://www.iclora.app/pwa-icon-512.png" alt="iClora logo" width="96" />
</p>

<h1 align="center">iClora Backend</h1>

<p align="center">
  The open-source Node.js API backend for the iClora website, iClora Cloud dashboard, iClora Photos web app, Notes, Contacts, account security, storage tracking, and Android Photos App.
</p>

<p align="center">
  <a href="https://www.iclora.app">Website</a>
  |
  <a href="https://github.com/sanketpadhyal/iClora.git">Frontend Repository</a>
  |
  <a href="https://github.com/sanketpadhyal/iClora-Backend.git">Backend Repository</a>
  |
  <a href="https://github.com/sanketpadhyal/Florence-BACKEND.git">Florence Backend</a>
  |
  <a href="https://github.com/sanketpadhyal/iClora-Photos-App.git">Android App</a>
</p>

<p align="center">
  <a href="https://github.com/sanketpadhyal/iClora-Backend.git">
    <img src="https://img.shields.io/badge/Backend-Open_Source-111827?style=for-the-badge&logo=nodedotjs&logoColor=3C873A" alt="Backend Open Source" />
  </a>
  <a href="https://www.iclora.app">
    <img src="https://img.shields.io/badge/Live_Website-www.iclora.app-00C853?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Live Website" />
  </a>
  <a href="https://github.com/sanketpadhyal/iClora.git">
    <img src="https://img.shields.io/badge/Frontend-iClora-2563EB?style=for-the-badge&logo=react&logoColor=61DAFB" alt="Frontend Repository" />
  </a>
  <a href="https://github.com/sanketpadhyal/Florence-BACKEND.git">
    <img src="https://img.shields.io/badge/AI-Florence_Backend-7C3AED?style=for-the-badge&logo=huggingface&logoColor=white" alt="Florence Backend" />
  </a>
  <a href="https://github.com/sanketpadhyal/iClora-Photos-App.git">
    <img src="https://img.shields.io/badge/Android-Photos_App-16A34A?style=for-the-badge&logo=android&logoColor=white" alt="Android Photos App" />
  </a>
</p>

## Overview

iClora Backend is the main API server for the iClora ecosystem. It connects the iClora React frontend and Android Photos App to authentication, sessions, profile data, Photos, Notes, Contacts, storage usage, passkeys, device activity, account deletion, media uploads, and AI photo search processing.

This backend is built with Node.js and Express. It uses Firebase Admin for account verification and Firestore data, Cloudinary for protected media flows, JWT sessions for web and mobile clients, optional Supabase modules for Notes and Contacts, optional Redis-backed rate limiting, and an external Florence-2 backend for AI photo captions.

> [!IMPORTANT]
> **Open Source Notice**
> This repository is prepared for public release. Real `.env` files, Firebase service account JSON files, JWT secrets, Cloudinary secrets, Supabase service role keys, Redis URLs, email provider keys, and private deployment credentials are intentionally excluded.

> [!WARNING]
> **Credentials**
> If a real `.env` or Firebase service account file was ever committed before this cleanup, rotate or revoke those credentials before publishing. Removing files from the latest commit does not remove them from existing Git history.

## Product Links

| Product Surface | Link |
| --- | --- |
| Live Website | [www.iclora.app](https://www.iclora.app) |
| Frontend Repository | [sanketpadhyal/iClora.git](https://github.com/sanketpadhyal/iClora.git) |
| Backend Repository | [sanketpadhyal/iClora-Backend.git](https://github.com/sanketpadhyal/iClora-Backend.git) |
| Florence Backend Repository | [sanketpadhyal/Florence-BACKEND.git](https://github.com/sanketpadhyal/Florence-BACKEND.git) |
| Android Photos App Repository | [sanketpadhyal/iClora-Photos-App.git](https://github.com/sanketpadhyal/iClora-Photos-App.git) |

## Backend Role In iClora

| Client | Backend Responsibility |
| --- | --- |
| iClora Website | Auth session exchange, dashboard data, Photos, Notes, Contacts, profile, storage, account security |
| iClora Photos App | Mobile session support, photo backup, cloud gallery data, sync status, signed upload flow |
| Florence Backend | Receives image caption jobs from this backend and returns AI search metadata |
| Firebase | Provides Google identity and Firestore/Firebase Admin data access |
| Cloudinary | Stores protected media through signed upload and signed delivery flows |

## What The Backend Does

1. Receives a Firebase ID token from the web frontend or Android app.
2. Verifies the token with Firebase Admin.
3. Creates an iClora backend session using JWT.
4. Tracks session activity and device metadata.
5. Serves cloud app APIs for Photos, Notes, and Contacts.
6. Creates signed Cloudinary upload payloads.
7. Stores photo, note, contact, profile, and app metadata.
8. Enforces storage usage and quota rules.
9. Handles sensitive account flows such as passkeys and account deletion.
10. Sends selected account alert emails when email configuration is enabled.
11. Sends photos to the Florence backend for AI captioning when vision processing is enabled.

## Key Features

### Authentication And Sessions

- Firebase ID token verification.
- Backend JWT session creation.
- HTTP-only cookie sessions for browser clients.
- Bearer-token API support for app and web clients.
- Separate web and application session lifetimes.
- Stale session response tagging.
- Logout and session expiration support.
- Device and login activity tracking.
- Origin and CORS validation.

### Passkeys And Account Security

- WebAuthn passkey registration.
- Passkey authentication.
- Passkey deletion.
- Account activity session list.
- Expire selected sessions.
- Sensitive action rate limiting.
- Account deletion verification with Google or passkey.
- Account deletion cleanup across app data and media references.

### Photos API

- Photos app activation.
- Photo library listing with pagination.
- Hidden Photos listing and unlock flow.
- Secure upload signature generation.
- Cloudinary signed upload integration.
- Photo metadata creation.
- Photo patch/update support.
- Delete and pending-delete sync support.
- Recently Deleted restore.
- Permanent delete.
- Delete all recently deleted photos.
- Public share link creation.
- Share link deletion.
- Public shared photo and media routes.
- Upload health endpoint.
- Background AI vision cycle integration.

### Notes API

- Notes app activation.
- Notes list.
- Notes preview for dashboard.
- Create, patch, and delete notes.
- Create, rename, and delete folders.
- Firebase-backed implementation.
- Optional Supabase-backed implementation when Supabase is configured.
- Cache-friendly payloads for the frontend.

### Contacts API

- Contacts app activation.
- Contacts list.
- Contacts preview for dashboard.
- Create, patch, and delete contacts.
- Contact profile photo upload.
- Cloudinary cleanup hooks.
- Firebase-backed implementation.
- Optional Supabase-backed implementation when Supabase is configured.

### Profile And Dashboard

- User profile reads through `/auth/me`.
- Profile update routes.
- Profile photo upload route.
- Dashboard preference routes.
- Cloud app normalization route.
- Storage refresh route.
- Per-app storage usage calculation.
- Plan/storage fields for dashboard rendering.

### Alerts And Emails

- Login alert email support.
- Settings/account alert email support.
- Resend integration through environment variables.
- Reply-to and sender configuration.
- Rate limiting for alert sends.

## API Surface

| Area | Routes |
| --- | --- |
| Health | `GET /health` |
| Auth | `POST /auth/session`, `GET /auth/me`, `POST /auth/logout` |
| Passkeys | `GET /passkey/me`, `POST /passkey/register/options`, `POST /passkey/register/verify`, `DELETE /passkey/:credentialId`, `POST /auth/passkey/options`, `POST /auth/passkey/verify` |
| Activity | `GET /auth/activity/sessions`, `DELETE /auth/activity/sessions/:sessionId`, `DELETE /auth/activity/sessions/:sessionId/expired` |
| Account Deletion | `POST /auth/delete-account/google/verify`, `POST /auth/delete-account/passkey/options`, `POST /auth/delete-account/passkey/verify`, `POST /auth/delete-account` |
| Profile | `PUT /profile/me`, `POST /users/me/profile-photo` |
| Dashboard | `GET /dashboard-tweaks/me`, `PUT /dashboard-tweaks/me`, `POST /cloud-apps/normalize` |
| Storage | `GET /storage/refresh` |
| Photos | `POST /photos/setup`, `GET /photos`, `GET /photos/upload-health`, `POST /photos/upload-signature`, `POST /photos`, `PATCH /photos/:photoId`, `DELETE /photos/:photoId`, `POST /photos/delete` |
| Hidden Photos | `GET /photos/hidden`, `GET /photos/hidden-auth`, `POST /photos/hidden-auth/setup`, `POST /photos/hidden-auth/verify`, `POST /photos/hidden-auth/google/verify`, `POST /photos/hidden-auth/passkey/options`, `POST /photos/hidden-auth/passkey/verify` |
| Recently Deleted | `GET /photos/recently-deleted`, `POST /photos/recently-deleted/restore`, `DELETE /photos/recently-deleted/:photoId`, `POST /photos/recently-deleted/delete-all` |
| Photo Sharing | `GET /photos/share/:token`, `GET /photos/share/:token/media/:photoIndex`, `GET /photos/share/:token/media`, `GET /photos/share-links`, `POST /photos/share-links`, `DELETE /photos/share-links/:linkId` |
| Notes | `POST /notes/setup`, `GET /notes`, `GET /notes/preview`, `POST /notes`, `PATCH /notes/:noteId`, `DELETE /notes/:noteId` |
| Note Folders | `POST /notes/folders`, `PATCH /notes/folders/:folderId`, `DELETE /notes/folders/:folderId` |
| Contacts | `POST /contacts/setup`, `GET /contacts`, `GET /contacts/preview`, `POST /contacts`, `PATCH /contacts/:contactId`, `DELETE /contacts/:contactId`, `POST /contacts/:contactId/photo` |

## Tech Stack

| Component | Technology |
| --- | --- |
| Runtime | Node.js |
| API Framework | Express |
| Auth Verification | Firebase Admin |
| Database | Firestore |
| Optional Database Modules | Supabase |
| Media Storage | Cloudinary |
| Sessions | JSON Web Tokens, HTTP-only cookies, bearer tokens |
| Security Middleware | Helmet, CORS, origin checks |
| Rate Limiting | Express Rate Limit, optional Redis store |
| File Uploads | Multer |
| Passkeys | SimpleWebAuthn Server |
| Email Alerts | Resend-compatible HTTP API |
| AI Integration | Florence backend over HTTP |

## Project Structure

| Directory / File | Description |
| --- | --- |
| `index.js` | Main Express server, config, middleware, auth session routes, router mounting |
| `firebase.js` | Firebase Admin initialization from environment-provided credentials |
| `auth/` | Auth sessions, passkeys, activity tracking, account deletion |
| `photos/` | Photos API, setup, recently deleted, Android sync helpers |
| `notes/` | Firebase and Supabase Notes APIs |
| `contacts/` | Firebase and Supabase Contacts APIs plus contact photo uploads |
| `profile/` | Profile update API |
| `dashboard_tweeks/` | Dashboard personalization routes |
| `cloud_apps/` | Cloud app normalization route |
| `storage/` | Storage usage and quota helpers |
| `supabase/` | Supabase client, SQL schemas, migration helpers |
| `vision process/` | Background Florence caption cycle |
| `alerts-mails/` | Login and settings alert email helpers |

## Environment Variables

Create a local `.env` file from the public example:

```bash
cp .env.example .env
```

### Core Server

```env
PORT=8080
HOST=0.0.0.0
NODE_ENV=development
FRONTEND_ORIGIN=http://localhost:3000
FRONTEND_URL=http://localhost:3000
```

### Sessions

```env
JWT_SECRET=
JWT_ISSUER=iclora
JWT_AUDIENCE=iclora-web
COOKIE_NAME=iclora_session
COOKIE_SECURE=false
COOKIE_SAME_SITE=lax
```

### Firebase Admin

Use one of these credential options:

```env
FIREBASE_SERVICE_ACCOUNT_JSON=
FIREBASE_SERVICE_ACCOUNT_BASE64=
FIREBASE_SERVICE_ACCOUNT_PATH=
```

For production, prefer managed service account credentials on the hosting provider when possible.

### Cloudinary

```env
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
```

### Florence Vision Backend

```env
VISION_API_URL=
VISION_CYCLE_ENABLED=false
VISION_CYCLE_INTERVAL_MS=30000
VISION_CYCLE_TIMEOUT_MS=20000
VISION_CYCLE_USER_SCAN_LIMIT=100
```

### Optional Supabase

```env
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

### Optional Redis Rate Limiting

```env
REDIS_ENABLED=false
REDIS_URL=
```

### Optional Email Alerts

```env
RESEND_API_KEY=
RESEND_API=
RESEND_FROM=
RESEND_REPLY_TO=
ALERT_EMAIL_FROM=
ALERT_EMAIL_REPLY_TO=
```

## Getting Started

### Prerequisites

- Node.js 18 or newer.
- npm.
- Firebase project with Firebase Admin access.
- Cloudinary account for profile photos and photo media.
- iClora frontend running locally or deployed.
- Optional Florence backend for AI photo captions.
- Optional Supabase for Notes and Contacts modules.
- Optional Redis for distributed rate limiting.

### Step 1: Install Dependencies

```bash
npm install
```

### Step 2: Configure Environment

```bash
cp .env.example .env
```

Fill `.env` with your own credentials and URLs.

### Step 3: Start Development Server

```bash
npm run dev
```

The API defaults to:

```text
http://localhost:8080
```

### Step 4: Health Check

```bash
curl http://localhost:8080/health
```

### Step 5: Start Production Server

```bash
npm start
```

## Android App Integration

iClora Photos App uses this backend for mobile photo backup and cloud gallery viewing.

Repository:

[sanketpadhyal/iClora-Photos-App.git](https://github.com/sanketpadhyal/iClora-Photos-App.git)

The Android app depends on backend support for:

- Existing iClora account sign-in.
- Application-friendly sessions.
- Authenticated API calls.
- Storage usage checks before backup.
- Signed photo upload flow.
- Cloud gallery fetch.
- Photo search data.
- Recently Deleted actions.
- Secure media access.

Users create and manage accounts on the iClora website. The Android app signs into the same account and syncs photos into the same Photos cloud.

## Florence Backend Integration

Florence-BACKEND is the separate AI service used by the backend vision cycle.

Repository:

[sanketpadhyal/Florence-BACKEND.git](https://github.com/sanketpadhyal/Florence-BACKEND.git)

Set `VISION_API_URL` to the deployed Florence backend URL and enable `VISION_CYCLE_ENABLED=true` when you want this backend to process queued photo captions.

Vision flow:

1. Photo is uploaded and stored.
2. Photo metadata marks vision processing as pending.
3. Backend vision cycle finds a pending photo.
4. Backend signs a protected Cloudinary image URL.
5. Backend sends the image to Florence-BACKEND.
6. Florence returns a short caption.
7. Backend stores `visionLabel`, `visionCaption`, `visionTags`, and `searchText`.
8. Frontend and Android clients can use that metadata for search.

## Cloud Run Deployment

The backend can run on Google Cloud Run or another Node.js hosting provider.

Recommended Cloud Run settings:

| Setting | Value |
| --- | --- |
| Runtime | Node.js buildpacks |
| Container Port | `8080` |
| Memory | At least `1 GiB`, more if traffic or upload volume grows |
| CPU | `1` or higher |
| Min Instances | `0` or higher depending on cold-start needs |
| Required Production Env | `JWT_SECRET`, `FRONTEND_ORIGIN`, Firebase credentials, Cloudinary credentials |

Example command:

```bash
gcloud run deploy iclora-backend --source . --region YOUR_REGION
```

## Security Notes

This backend controls sensitive product behavior.

- Do not expose backend secrets to the frontend.
- Do not commit `.env` files.
- Do not commit Firebase service account JSON files.
- Use a long random `JWT_SECRET` in production.
- Restrict `FRONTEND_ORIGIN` to trusted origins.
- Use secure cookies in production.
- Keep Cloudinary API secret only on the backend.
- Use Firebase Admin credentials only in secure backend environments.
- Rotate credentials if they were ever pushed publicly.

## Open Source Safety

This repository has been cleaned for public release by using:

- `.env.example` for public configuration shape.
- `.gitignore` rules for local secrets.
- Environment variables for private values.
- No committed Firebase service account file.
- No committed real `.env` file.
- No hardcoded Florence production backend URL.
- iClora-branded package metadata.

## Roadmap

- Add automated route tests.
- Add stricter integration tests for auth and sessions.
- Add OpenAPI documentation.
- Add more structured logging.
- Add admin-only operational dashboards.
- Add richer storage analytics.
- Add deeper Android backup observability.
- Add more complete Supabase migration docs.

## Developed By

Developed by **Sanket Padhyal**.

Personal website: [www.sanketpadhyal.in](https://www.sanketpadhyal.in)

GitHub: [@sanketpadhyal](https://github.com/sanketpadhyal)

## License

Add a license before publishing if outside users are allowed to reuse, modify, or distribute this backend.
