import crypto from 'crypto';
import { adminDb, adminFirestore } from './firebase-admin.js';
import { normalizeTier, revokeAllSessionsForUid, writeAuditLog } from './license.js';

const SUBS_WITHOUT_EXPIRY = new Set(['lifetime', 'beta']);
const KEY_HASH_PEPPER = String(process.env.SUBSCRIPTION_KEY_PEPPER || process.env.ADMIN_API_SECRET || '').trim();
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ADMIN_LOOKUP_TIMEOUT_MS = Number(process.env.ADMIN_LOOKUP_TIMEOUT_MS || 5000);
const ADMIN_WRITE_TIMEOUT_MS = Number(process.env.ADMIN_WRITE_TIMEOUT_MS || 8000);
const DATABASE_URL = String(
  process.env.FIREBASE_DATABASE_URL ||
  'https://fade-client-default-rtdb.firebaseio.com'
).replace(/\/$/, '');

function nowMs() {
  return Date.now();
}

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function normalizeSubscriptionKey(rawKey) {
  return String(rawKey || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 64);
}

export function hashSubscriptionKey(rawKey) {
  const normalized = normalizeSubscriptionKey(rawKey);
  if (!normalized) {
    return '';
  }
  return crypto.createHash('sha256').update(`${KEY_HASH_PEPPER}:${normalized}`, 'utf8').digest('hex');
}

export function generateSubscriptionKey() {
  const bytes = crypto.randomBytes(20);
  let raw = '';
  for (const byte of bytes) {
    raw += KEY_ALPHABET[byte % KEY_ALPHABET.length];
  }
  return `AURA-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

export function sanitizeKeyPublicRecord(record = {}, keyHash = '') {
  return {
    id: keyHash,
    plan: String(record.plan || '1_month'),
    durationDays: toNumber(record.durationDays, 0),
    durationMs: toNumber(record.durationMs, 0),
    note: String(record.note || '').slice(0, 120),
    createdAt: toNumber(record.createdAt, 0) || null,
    createdBy: record.createdBy || null,
    redeemed: record.redeemed === true,
    redeemedAt: toNumber(record.redeemedAt, 0) || null,
    redeemedBy: record.redeemedBy || null
  };
}

function getSubscriptionKeyRef(keyHash) {
  return adminDb.ref(`subscriptionKeys/${keyHash}`);
}

async function getSubscriptionKeyRecord(keyHash) {
  if (adminFirestore) {
    const snapshot = await withTimeout(
      adminFirestore.collection('subscriptionKeys').doc(keyHash).get(),
      ADMIN_LOOKUP_TIMEOUT_MS,
      'Firestore subscription key lookup timed out.'
    );
    return snapshot.exists ? snapshot.data() || null : null;
  }

  const snapshot = await withTimeout(
    getSubscriptionKeyRef(keyHash).get(),
    ADMIN_LOOKUP_TIMEOUT_MS,
    'RTDB subscription key lookup timed out.'
  );
  return snapshot.exists() ? snapshot.val() || null : null;
}

export async function getUserRole(uid) {
  try {
    if (adminFirestore) {
      const adminRoleDoc = await withTimeout(
        adminFirestore.collection('adminRoles').doc(uid).get(),
        ADMIN_LOOKUP_TIMEOUT_MS,
        'Firestore admin role lookup timed out.'
      );
      const adminRole = adminRoleDoc.exists ? adminRoleDoc.data() || {} : {};
      if (adminRole.admin === true || String(adminRole.role || '').toLowerCase() === 'admin') {
        return 'admin';
      }

      const userRoleDoc = await withTimeout(
        adminFirestore.collection('users').doc(uid).get(),
        ADMIN_LOOKUP_TIMEOUT_MS,
        'Firestore user role lookup timed out.'
      );
      const userRole = userRoleDoc.exists ? String(userRoleDoc.data()?.role || '').toLowerCase() : '';
      if (userRole === 'admin') {
        return 'admin';
      }
    }
  } catch (error) {
    console.warn('getUserRole: Firestore role lookup failed:', error?.message || error);
  }

  try {
    const rtdbRoleSnapshot = await withTimeout(
      adminDb.ref(`users/${uid}/role`).get(),
      ADMIN_LOOKUP_TIMEOUT_MS,
      'RTDB role lookup timed out.'
    );
    if (String(rtdbRoleSnapshot.val() || '').toLowerCase() === 'admin') {
      return 'admin';
    }
  } catch (error) {
    console.warn('getUserRole: RTDB role lookup failed:', error?.message || error);
  }

  return 'user';
}

async function getUserRoleFromAuthenticatedRtdb(uid, idToken) {
  const token = String(idToken || '').trim();
  if (!uid || !token) {
    return 'user';
  }

  try {
    const response = await withTimeout(
      fetch(`${DATABASE_URL}/users/${uid}/role.json?auth=${encodeURIComponent(token)}`, {
        method: 'GET'
      }),
      ADMIN_LOOKUP_TIMEOUT_MS,
      'Authenticated RTDB role lookup timed out.'
    );

    if (!response.ok) {
      return 'user';
    }

    const role = await response.json().catch(() => null);
    return String(role || '').toLowerCase() === 'admin' ? 'admin' : 'user';
  } catch (error) {
    console.warn('getUserRoleFromAuthenticatedRtdb failed:', error?.message || error);
    return 'user';
  }
}

export async function requireAdminUser(auth) {
  if (!auth?.ok || !auth.uid) {
    return { ok: false, status: 401, message: 'Unauthorized.' };
  }

  if (String(auth.role || '').toLowerCase() === 'admin') {
    return { ok: true, role: 'admin' };
  }

  const authenticatedRole = await getUserRoleFromAuthenticatedRtdb(auth.uid, auth.idToken);
  if (authenticatedRole === 'admin') {
    return { ok: true, role: 'admin' };
  }

  const role = await getUserRole(auth.uid);
  if (role !== 'admin') {
    return { ok: false, status: 403, message: 'Admin role required.' };
  }

  return { ok: true, role };
}

export async function createSubscriptionKey({ createdBy, planRaw, durationDaysRaw, noteRaw = '' }) {
  const plan = normalizeTier(planRaw || '1_month');
  if (!plan || plan === 'none' || plan === 'hwid_reset') {
    return { ok: false, message: 'Unsupported subscription plan.' };
  }

  const durationDays = SUBS_WITHOUT_EXPIRY.has(plan) ? 0 : Math.floor(toNumber(durationDaysRaw, 0));
  if (!SUBS_WITHOUT_EXPIRY.has(plan) && (durationDays < 1 || durationDays > 3650)) {
    return { ok: false, message: 'Duration must be from 1 to 3650 days.' };
  }

  const key = generateSubscriptionKey();
  const keyHash = hashSubscriptionKey(key);
  if (!keyHash) {
    return { ok: false, message: 'Failed to generate key.' };
  }

  const now = nowMs();
  const record = {
    plan,
    durationDays,
    durationMs: durationDays > 0 ? durationDays * 24 * 60 * 60 * 1000 : 0,
    note: String(noteRaw || '').trim().slice(0, 120),
    createdBy,
    createdAt: now,
    redeemed: false,
    redeemedBy: null,
    redeemedAt: null
  };

  if (adminFirestore) {
    await withTimeout(
      adminFirestore.collection('subscriptionKeys').doc(keyHash).set(record),
      ADMIN_WRITE_TIMEOUT_MS,
      'Subscription key write timed out.'
    );
  } else {
    await withTimeout(
      getSubscriptionKeyRef(keyHash).set(record),
      ADMIN_WRITE_TIMEOUT_MS,
      'Subscription key write timed out.'
    );
  }
  await writeAuditLog('subscription_key_created', {
    uid: createdBy,
    keyHash,
    plan,
    durationDays
  });

  return { ok: true, key, keyHash, record: sanitizeKeyPublicRecord(record, keyHash) };
}

export async function listSubscriptionKeys(limit = 25) {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 25, 100));

  if (adminFirestore) {
    const snapshot = await adminFirestore
      .collection('subscriptionKeys')
      .orderBy('createdAt', 'desc')
      .limit(normalizedLimit)
      .get();

    return snapshot.docs.map((doc) => sanitizeKeyPublicRecord(doc.data() || {}, doc.id));
  }

  const snapshot = await withTimeout(
    adminDb.ref('subscriptionKeys').get(),
    ADMIN_LOOKUP_TIMEOUT_MS,
    'RTDB subscription key list timed out.'
  );
  const data = snapshot.exists() ? snapshot.val() || {} : {};

  return Object.entries(data)
    .map(([id, record]) => sanitizeKeyPublicRecord(record || {}, id))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, normalizedLimit);
}

export async function redeemSubscriptionKey({ rawKey, uid }) {
  const normalizedKey = normalizeSubscriptionKey(rawKey);
  const keyHash = hashSubscriptionKey(normalizedKey);
  if (!normalizedKey || !keyHash) {
    return { ok: false, status: 400, message: 'Invalid key format.' };
  }

  const now = nowMs();
  let selectedRecord = null;
  let redeemed = false;

  if (adminFirestore) {
    const keyRef = adminFirestore.collection('subscriptionKeys').doc(keyHash);
    redeemed = await adminFirestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(keyRef);
      if (!snapshot.exists) {
        return false;
      }

      const current = snapshot.data() || {};
      if (current.redeemed === true) {
        return false;
      }

      selectedRecord = current;
      transaction.update(keyRef, {
        redeemed: true,
        redeemedBy: uid,
        redeemedAt: now
      });
      return true;
    });
  } else {
    const record = await getSubscriptionKeyRecord(keyHash);
    if (record && record.redeemed !== true) {
      selectedRecord = record;
      await withTimeout(
        getSubscriptionKeyRef(keyHash).update({
          redeemed: true,
          redeemedBy: uid,
          redeemedAt: now
        }),
        ADMIN_WRITE_TIMEOUT_MS,
        'Subscription key redeem write timed out.'
      );
      redeemed = true;
    }
  }

  if (!redeemed || !selectedRecord) {
    return { ok: false, status: 400, message: 'Key is invalid or already redeemed.' };
  }

  const plan = normalizeTier(selectedRecord.plan || '1_month');
  const durationMs = toNumber(selectedRecord.durationMs, 0);
  const userRef = adminDb.ref(`users/${uid}`);
  const entitlementRef = adminDb.ref(`entitlements/${uid}`);
  const userSnapshot = await userRef.get();
  const user = userSnapshot.val() || {};

  const currentExpiresAt = toNumber(user.subscriptionExpiresAt, 0);
  const expiresAt = SUBS_WITHOUT_EXPIRY.has(plan) ? null : Math.max(now, currentExpiresAt) + durationMs;

  await userRef.update({
    subscription: plan,
    subscriptionExpiresAt: expiresAt,
    lastKeyRedeemedAt: now,
    lastKeyHash: keyHash
  });

  await entitlementRef.set({
    plan,
    state: 'active',
    expiresAt,
    source: 'subscription_key',
    keyHash,
    updatedAt: now
  });

  await revokeAllSessionsForUid(uid);
  await writeAuditLog('subscription_key_redeemed', {
    uid,
    keyHash,
    plan,
    durationMs,
    expiresAt
  });

  return {
    ok: true,
    plan,
    expiresAt,
    durationDays: toNumber(selectedRecord.durationDays, 0)
  };
}
