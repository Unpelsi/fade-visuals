import { initializeApp } from 'firebase/app';
import { getAuth, User } from 'firebase/auth';
import { getDatabase, get, ref, serverTimestamp, set } from 'firebase/database';

const defaultFirebaseConfig = {
  apiKey: 'AIzaSyCD61hKVJi16c0NVQTV1ZKOsFjjeXdgzXQ',
  authDomain: 'fade-client.firebaseapp.com',
  projectId: 'fade-client',
  storageBucket: 'fade-client.firebasestorage.app',
  messagingSenderId: '838857350681',
  appId: '1:838857350681:web:125f4f7bab426ab8f49488',
  databaseURL: 'https://fade-client-default-rtdb.firebaseio.com'
};

const firebaseConfig = {
  apiKey: String(import.meta.env.VITE_FIREBASE_API_KEY || defaultFirebaseConfig.apiKey),
  authDomain: String(import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || defaultFirebaseConfig.authDomain),
  projectId: String(import.meta.env.VITE_FIREBASE_PROJECT_ID || defaultFirebaseConfig.projectId),
  storageBucket: String(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || defaultFirebaseConfig.storageBucket),
  messagingSenderId: String(import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || defaultFirebaseConfig.messagingSenderId),
  appId: String(import.meta.env.VITE_FIREBASE_APP_ID || defaultFirebaseConfig.appId),
  databaseURL: String(import.meta.env.VITE_FIREBASE_DATABASE_URL || defaultFirebaseConfig.databaseURL)
};

const missingFirebaseEnv = Object.entries({
  VITE_FIREBASE_API_KEY: firebaseConfig.apiKey,
  VITE_FIREBASE_AUTH_DOMAIN: firebaseConfig.authDomain,
  VITE_FIREBASE_PROJECT_ID: firebaseConfig.projectId,
  VITE_FIREBASE_STORAGE_BUCKET: firebaseConfig.storageBucket,
  VITE_FIREBASE_MESSAGING_SENDER_ID: firebaseConfig.messagingSenderId,
  VITE_FIREBASE_APP_ID: firebaseConfig.appId,
  VITE_FIREBASE_DATABASE_URL: firebaseConfig.databaseURL
})
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingFirebaseEnv.length > 0) {
  console.warn(
    `[Aura] Missing Firebase env vars: ${missingFirebaseEnv.join(', ')}. ` +
      'Using built-in fallback config. Set VITE_FIREBASE_* in deployment environment.'
  );
}

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

export function normalizeUsername(rawUsername: string) {
  return String(rawUsername || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24);
}

export function usernameToEmail(username: string) {
  const normalized = normalizeUsername(username);
  return normalized ? `${normalized}@aura.local` : '';
}

export function emailToUsername(email: string | null | undefined) {
  const raw = String(email || '').trim().toLowerCase();
  if (!raw) {
    return '';
  }

  if (raw.endsWith('@aura.local')) {
    return normalizeUsername(raw.slice(0, raw.indexOf('@')));
  }

  return normalizeUsername(raw.split('@')[0]);
}

function getApiErrorMessage(payload: any, response: Response) {
  const base = String(payload?.error || payload?.message || `HTTP ${response.status}`).trim();
  const details = String(payload?.details || '').trim();
  if (!details) {
    return base;
  }
  return `${base} (${details})`;
}

function mapTierToBackend(tier: string) {
  const normalized = String(tier || '').trim().toLowerCase();
  if (['beta', '1_month', 'lifetime', 'hwid_reset'].includes(normalized)) {
    return normalized;
  }
  if (normalized.includes('1') && normalized.includes('РјРµСЃСЏС†')) {
    return '1_month';
  }
  if (normalized.includes('РЅР°РІСЃРµРіРґР°') || normalized.includes('lifetime')) {
    return 'lifetime';
  }
  if (normalized.includes('beta') || normalized.includes('Р±РµС‚Р°')) {
    return 'beta';
  }
  if (normalized.includes('hwid') || normalized.includes('СЃР±СЂРѕСЃ')) {
    return 'hwid_reset';
  }
  return normalized;
}

async function authorizedFetch(url: string, init: RequestInit = {}) {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('User is not authenticated.');
  }

  const idToken = await user.getIdToken();
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${idToken}`);
  headers.set('Content-Type', 'application/json');

  const controller = new AbortController();
  const timeoutMs = 15000;
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: init.signal || controller.signal
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function ensureUserDocument(user: User | null, username = '') {
  if (!user) {
    return;
  }

  const userRef = ref(db, `users/${user.uid}`);
  const entitlementRef = ref(db, `entitlements/${user.uid}`);
  const normalizedUsername = normalizeUsername(username || emailToUsername(user.email));

  try {
    const snapshot = await get(userRef);
    if (!snapshot.exists()) {
      await set(userRef, {
        email: user.email,
        username: normalizedUsername || null,
        role: 'user',
        subscription: 'none',
        hwidHash: null,
        createdAt: serverTimestamp()
      });
    } else if (normalizedUsername && !snapshot.val()?.username) {
      await set(ref(db, `users/${user.uid}/username`), normalizedUsername);
    }

    const entitlementSnapshot = await get(entitlementRef);
    if (!entitlementSnapshot.exists()) {
      await set(entitlementRef, {
        plan: 'none',
        state: 'pending',
        expiresAt: null,
        source: 'signup',
        updatedAt: Date.now()
      });
    }
  } catch (error) {
    console.error('ensureUserDocument error:', error);
  }
}

export async function createCheckoutPayment(tierUi: string, returnUrl: string) {
  const tier = mapTierToBackend(tierUi);
  const response = await authorizedFetch('/api/payments/create', {
    method: 'POST',
    body: JSON.stringify({
      tier,
      returnUrl
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) {
    throw new Error(getApiErrorMessage(payload, response));
  }

  return {
    paymentId: String(payload.paymentId || ''),
    confirmationUrl: String(payload.confirmationUrl || ''),
    expiresAt: Number(payload.expiresAt || 0)
  };
}

export async function fetchAccountProfile() {
  const response = await authorizedFetch('/api/account/me', {
    method: 'GET'
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) {
    throw new Error(getApiErrorMessage(payload, response));
  }
  return payload;
}

export async function requestLauncherDownloadLink() {
  const response = await authorizedFetch('/api/account/download/launcher-url', {
    method: 'GET'
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok || !payload?.url) {
    throw new Error(getApiErrorMessage(payload, response));
  }

  return {
    url: String(payload.url),
    expiresAt: Number(payload.expiresAt || 0),
    sha256: String(payload.sha256 || ''),
    version: String(payload.version || '')
  };
}

export async function requestManualHwidReset() {
  const response = await authorizedFetch('/api/account/hwid-reset', {
    method: 'POST',
    body: JSON.stringify({})
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) {
    throw new Error(getApiErrorMessage(payload, response));
  }

  return {
    message: String(payload.message || 'HWID reset completed.'),
    remainingResetCredits: Number(payload.remainingResetCredits || 0)
  };
}

export async function redeemSubscriptionKey(key: string) {
  const response = await authorizedFetch('/api/account/redeem-key', {
    method: 'POST',
    body: JSON.stringify({ key })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) {
    throw new Error(getApiErrorMessage(payload, response));
  }

  return {
    plan: String(payload.plan || 'none'),
    expiresAt: Number(payload.expiresAt || 0) || null,
    durationDays: Number(payload.durationDays || 0)
  };
}

export async function createAdminSubscriptionKey(plan: string, durationDays: number, note = '') {
  const response = await authorizedFetch('/api/admin/keys/create', {
    method: 'POST',
    body: JSON.stringify({ plan, durationDays, note })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) {
    throw new Error(getApiErrorMessage(payload, response));
  }

  return {
    key: String(payload.key || ''),
    record: payload.record || null
  };
}

export async function fetchAdminSubscriptionKeys() {
  const response = await authorizedFetch('/api/admin/keys/list', {
    method: 'GET'
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.ok) {
    throw new Error(getApiErrorMessage(payload, response));
  }

  return Array.isArray(payload.keys) ? payload.keys : [];
}
