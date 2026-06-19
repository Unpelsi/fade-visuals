import { activateSubscriptionFromPayment, writeAuditLog } from '../_lib/license.js';
import { adminDb } from '../_lib/firebase-admin.js';
import { badRequest, forbidden, getBody, methodNotAllowed, serverError } from '../_lib/http.js';
import { normalizeYooKassaStatus } from '../_lib/yookassa.js';
import crypto from 'crypto';

function getIncomingSecret(req) {
  return String(
    req.headers['x-yookassa-secret']
      || req.headers['x-webhook-secret']
      || req.headers['x-payment-secret']
      || ''
  ).trim();
}

function isDuplicateCompleted(payment, providerTxId) {
  return (
    String(payment?.status || '') === 'completed'
    && !!payment?.processedAt
    && String(payment?.providerTxId || '') === String(providerTxId || '')
  );
}

async function findPaymentRecord(paymentIdFromMeta, providerTxId) {
  if (paymentIdFromMeta) {
    const paymentRef = adminDb.ref(`payments/${paymentIdFromMeta}`);
    const paymentSnapshot = await paymentRef.get();
    if (paymentSnapshot.exists()) {
      return {
        paymentId: paymentIdFromMeta,
        paymentRef,
        payment: paymentSnapshot.val() || {}
      };
    }
  }

  const paymentsSnapshot = await adminDb.ref('payments').get();
  if (!paymentsSnapshot.exists()) {
    return null;
  }

  let found = null;
  paymentsSnapshot.forEach((child) => {
    if (found) {
      return;
    }

    const data = child.val() || {};
    if (providerTxId && String(data.providerTxId || '') === String(providerTxId)) {
      found = {
        paymentId: child.key,
        paymentRef: adminDb.ref(`payments/${child.key}`),
        payment: data
      };
    }
  });

  return found;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res);
  }

  const expectedSecret = String(process.env.YOOKASSA_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || '').trim();
  if (expectedSecret) {
    const incomingSecret = getIncomingSecret(req);
    if (!incomingSecret || incomingSecret !== expectedSecret) {
      return forbidden(res, 'Invalid webhook secret.');
    }
  }

  const body = getBody(req);
  const eventType = String(body.event || '').trim();
  const paymentObject = body.object || {};
  const providerTxId = String(paymentObject.id || '').trim();
  const providerStatusRaw = String(paymentObject.status || '').trim();
  const providerStatus = normalizeYooKassaStatus(providerStatusRaw);
  const providerPayloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(body || {}), 'utf8')
    .digest('hex');
  const metadata = paymentObject.metadata || {};

  const paymentIdFromMeta = String(metadata.paymentId || body.paymentId || '').trim();
  if (!providerTxId && !paymentIdFromMeta) {
    return badRequest(res, 'Webhook payload does not contain payment identifiers.');
  }

  try {
    await writeAuditLog('payment_webhook_received', {
      eventType,
      paymentId: paymentIdFromMeta || null,
      providerTxId: providerTxId || null,
      providerStatus: providerStatusRaw || null
    });

    const record = await findPaymentRecord(paymentIdFromMeta, providerTxId);
    if (!record) {
      await writeAuditLog('payment_webhook_unknown_payment', {
        eventType,
        paymentId: paymentIdFromMeta || null,
        providerTxId: providerTxId || null
      });
      return res.status(200).json({ ok: true, ignored: true, reason: 'payment_not_found' });
    }

    const { paymentId, paymentRef, payment } = record;
    if (isDuplicateCompleted(payment, providerTxId)) {
      await writeAuditLog('payment_duplicate_ignored', {
        eventType,
        paymentId,
        providerTxId
      });
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const now = Date.now();
    await paymentRef.update({
      providerTxId: providerTxId || payment.providerTxId || null,
      providerStatus: providerStatusRaw || null,
      status: providerStatus || payment.status || 'pending',
      providerPayloadHash,
      eventType: eventType || null,
      updatedAt: now
    });

    if (providerStatus === 'completed') {
      const userId = String(metadata.userId || payment.userId || '').trim();
      const tier = String(metadata.tier || payment.tier || '').trim();
      if (!userId || !tier) {
        await writeAuditLog('payment_webhook_missing_metadata', {
          paymentId,
          providerTxId
        });
        return badRequest(res, 'Webhook succeeded but userId/tier is missing.');
      }

      const applied = await activateSubscriptionFromPayment(userId, tier);
      await paymentRef.update({
        status: 'completed',
        processedAt: now,
        updatedAt: now
      });

      await writeAuditLog('payment_applied', {
        paymentId,
        providerTxId,
        userId,
        tier: applied.appliedTier,
        subscription: applied.subscription,
        subscriptionExpiresAt: applied.subscriptionExpiresAt
      });
    }

    if (providerStatus === 'failed') {
      const userId = String(metadata.userId || payment.userId || '').trim();
      if (userId) {
        await adminDb.ref(`entitlements/${userId}`).update({
          state: 'revoked',
          source: 'payment_refund_or_cancel',
          updatedAt: now
        });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('payments/yookassa-webhook error:', error);
    return serverError(res, 'Internal server error.', error?.message);
  }
}
