<p align="center">
  <img src="https://www.iclora.app/pwa-icon-512.png" alt="iClora logo" width="96" />
</p>

<h1 align="center">iClora Backend</h1>

<p align="center">
  The open-source Node.js API backend for the iClora personal cloud ecosystem (Website, Dashboard, Photos, Notes, Contacts, Security, and Android App).
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

---

## Overview

**iClora Backend** is the core API server for the iClora ecosystem. It handles authentication session exchanges, JWT security verification, Cloudinary media upload signatures, Firestore database persistence for Notes, Contacts, & Photos, device session activity, WebAuthn Passkeys, storage quota tracking, and background Florence-2 AI vision processing.

> [!IMPORTANT]
> **Open Source Notice**
> This repository is sanitized for public distribution. Production credentials, private Firebase service account keys, secret JWT keys, and Cloudinary secrets are excluded. Use `.env.example` to set up your environment variables.

---

## Key Updates & Enhancements

- **Resilient Session Auth**: Prioritizes `Authorization: Bearer` headers over stale browser cookies, with fallback JWT signature verification across environment configurations.
- **Native Firebase Firestore Persistence**: Notes, Contacts, User Profiles, and Storage Quotas run natively on Firebase Firestore.
- **Isolated Fault Tolerance**: Storage calculations and external service lookups are wrapped in safe try-catch handlers so secondary failures never break `/auth/me`, login, or media uploads.
- **Cloudinary Signed Media Uploads**: Secure direct-to-cloud photo uploads with server-side storage quota enforcement.
- **Florence AI Vision Cycle**: Background worker sends un-captioned user photos to the Florence AI backend for automated tagging, captioning, and visual search indexing.

---

## Ecosystem Links

| Product Surface | Link |
| --- | --- |
| Live Website | [www.iclora.app](https://www.iclora.app) |
| Frontend Repository | [sanketpadhyal/iClora.git](https://github.com/sanketpadhyal/iClora.git) |
| Backend Repository | [sanketpadhyal/iClora-Backend.git](https://github.com/sanketpadhyal/iClora-Backend.git) |
| Florence Backend Repository | [sanketpadhyal/Florence-BACKEND.git](https://github.com/sanketpadhyal/Florence-BACKEND.git) |
| Android App Repository | [sanketpadhyal/iClora-Photos-App.git](https://github.com/sanketpadhyal/iClora-Photos-App.git) |

---

## Architecture & API Modules

```text
iClora-Backend/
├── alerts-mails/         # Email alert templates and notification helpers
├── auth/                 # Firebase ID token verify, JWT sessions, passkeys, account deletion
├── cloud_apps/           # Normalization helpers for cloud applications
├── contacts/             # Contacts CRUD operations & profile photo handling (Firestore)
├── dashboard_tweeks/     # Dashboard accent colors & user customization APIs
├── notes/                # Notes & folders CRUD operations (Firestore)
├── photos/               # Photos upload signing, trash, hidden photos, sharing links
├── profile/              # User profile settings & photo management
├── storage/              # Per-user cloud storage quota enforcement
├── supabase/             # Optional Supabase migration utilities and fallback clients
├── vision process/       # Florence AI vision cycle worker for automatic photo captioning
├── index.js              # Express app entry point & route definitions
├── firebase.js           # Firebase Admin SDK initialization
├── .env.example          # Template for backend environment variables
└── package.json          # Node.js package definition
```

---

## Getting Started

### 1. Prerequisites
- **Node.js**: `v18.0.0` or higher
- **npm**: `v9.0.0` or higher
- **Firebase Project**: Admin Service Account with Firestore & Auth enabled
- **Cloudinary Account**: Cloud name, API Key, and Secret for image storage

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/sanketpadhyal/iClora-Backend.git
cd iClora-Backend
npm install
```

### 3. Environment Setup

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Configure your environment variables in `.env`:

```env
PORT=8080
HOST=0.0.0.0
FRONTEND_ORIGIN=http://localhost:3000

JWT_SECRET=your-long-random-jwt-secret-min-32-chars
JWT_ISSUER=iclora
JWT_AUDIENCE=iclora-web

COOKIE_NAME=iclora_session
COOKIE_SECURE=false
COOKIE_SAME_SITE=lax

FIREBASE_SERVICE_ACCOUNT_PATH=./service-account.json

CLOUDINARY_CLOUD_NAME=your-cloudinary-cloud-name
CLOUDINARY_API_KEY=your-cloudinary-api-key
CLOUDINARY_API_SECRET=your-cloudinary-api-secret

VISION_API_URL=https://florence-backend-production-3220.up.railway.app
REDIS_ENABLED=false
```

Place your Firebase Admin service account key as `service-account.json` in the root directory.

### 4. Running the Server

Start the development server:

```bash
npm start
```

For hot-reloading:

```bash
npm run dev
```

The server will listen on `http://localhost:8080`. You can test health status at `http://localhost:8080/health`.

---

## Deployment

Deployable to standard Node.js platforms such as **Railway**, **Cloud Run**, **Render**, **Fly.io**, or **AWS**:

1. Set environment variables on your host.
2. Provide Firebase service account credentials (via environment base64 JSON string or mounted file).
3. Ensure CORS origin allowlist includes your deployed frontend domain (`FRONTEND_ORIGIN`).

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Developer

Developed by **Sanket Padhyal**  
Website: [www.sanketpadhyal.in](https://www.sanketpadhyal.in)  
GitHub: [@sanketpadhyal](https://github.com/sanketpadhyal)
