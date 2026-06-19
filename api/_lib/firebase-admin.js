/**
 * Firebase Admin SDK initializer for Vercel serverless functions.
 *
 * The Admin SDK bypasses Firebase Security Rules entirely, which is what
 * we want for server-side API handlers.
 *
 * Auth options (in priority order):
 *  1. GOOGLE_APPLICATION_CREDENTIALS_JSON  — full service-account JSON as a string
 *  2. GOOGLE_APPLICATION_CREDENTIALS       — path to a service-account JSON file (local dev)
 *  3. Application Default Credentials       — works on Google Cloud / Firebase Hosting
 *
 * For Vercel: set GOOGLE_APPLICATION_CREDENTIALS_JSON in the project env vars
 * with the contents of your Firebase service account key JSON.
 */

import { cert, getApp, getApps, initializeApp as initAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import { getDatabase as getAdminDatabase } from 'firebase-admin/database';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

function resolveProjectId(serviceAccount = null) {
  return String(
    serviceAccount?.project_id ||
      process.env.FIREBASE_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GCLOUD_PROJECT ||
      ''
  ).trim();
}

function initAdmin() {
  if (getApps().length > 0) {
    return getApp();
  }

  const databaseURL =
    process.env.FIREBASE_DATABASE_URL ||
    'https://fade-client-default-rtdb.firebaseio.com';

  const credsJson = String(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || '').trim();
  if (credsJson) {
    try {
      const serviceAccount = JSON.parse(credsJson);
      const projectId = resolveProjectId(serviceAccount);
      return initAdminApp({
        credential: cert(serviceAccount),
        databaseURL,
        ...(projectId ? { projectId } : {})
      });
    } catch (parseErr) {
      console.error('[firebase-admin] Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON:', parseErr?.message);
    }
  }

  // Fallback: Application Default Credentials (works on GCP / emulator)
  const projectId = resolveProjectId();
  return initAdminApp({
    databaseURL,
    ...(projectId ? { projectId } : {})
  });
}

const adminApp = initAdmin();
export const adminProjectId = resolveProjectId();
export const adminAuth = adminProjectId ? getAdminAuth(adminApp) : null;
export const adminDb = getAdminDatabase(adminApp);

function resolveFirestoreDatabaseId() {
  const raw = String(process.env.FIRESTORE_DATABASE_ID || '').trim();
  if (!raw) {
    return undefined;
  }

  // The default Firestore database should be used unless a custom database id
  // is explicitly configured in the deployment environment.
  if (raw === '(default)') {
    return undefined;
  }

  return raw;
}

const firestoreDatabaseId = resolveFirestoreDatabaseId();
export const adminFirestore = adminProjectId
  ? firestoreDatabaseId
    ? getAdminFirestore(adminApp, firestoreDatabaseId)
    : getAdminFirestore(adminApp)
  : null;
