import admin from 'firebase-admin';
import { existsSync, readFileSync } from 'node:fs';

let firebaseReady = false;

function getServiceAccountFromEnv() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    return JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
  }

  return null;
}

export function getFirebaseAdmin(serviceAccountPath) {
  if (firebaseReady) return admin;

  const envServiceAccount = getServiceAccountFromEnv();
  if (envServiceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(envServiceAccount),
    });
  } else if (serviceAccountPath && existsSync(serviceAccountPath)) {
    const raw = readFileSync(serviceAccountPath, 'utf8');
    const serviceAccount = JSON.parse(raw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }

  firebaseReady = true;
  return admin;
}
