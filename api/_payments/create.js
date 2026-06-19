import { verifyRequestAuth } from '../_lib/auth.js';
import { adminDb } from '../_lib/firebase-admin.js';
import { badRequest, getBody, getRequestBaseUrl, methodNotAllowed, serverError, tooManyRequests, unauthorized } from '../_lib/http.js';
import { checkRateLimit, getClientIp } from '../_lib/rate-limit.js';
import { getTierPriceRub, createYooKassaPayment, normalizeYooKassaStatus } from '../_lib/yookassa.js';
import { writeAuditLog } from '../_lib/license.js';

const CREATE_LIMIT = Number(process.env.PAYMENTS_CREATE_RATE_LIMIT || 30);
const CREATE_WINDOW_MS = Number(process.env.PAYMENTS_CREATE_WINDOW_MS || 10 * 60 * 1000);

function resolveReturnUrl(req, requestedUrl = '') {
  const baseUrl = getRequestBaseUrl(req);
  if (!baseUrl) {
    return '';
  }

  const fallback = `${baseUrl}/?paymentReturn=1`;
  const raw = String(requestedUrl || '').trim();
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = new URL(raw);
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) {
      return fallback;
    }
    return parsed.toString();
  } catch (error) {
    return fallback;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res);
  }

  const ip = getClientIp(req);
  const limit = checkRateLimit(`payments-create:${ip}`, CREATE_LIMIT, CREATE_WINDOW_MS);
  if (!limit.allowed) {
    return tooManyRequests(res, limit.retryAfterMs);
  }

  const body = getBody(req);
  const tierRaw = body.tier;
  const returnUrl = resolveReturnUrl(req, body.returnUrl);
  const tokenFromBody = String(body.idToken || '').trim();

  if (!tierRaw) {
    return badRequest(res, 'tier is required.');
  }

  if (!returnUrl) {
    return serverError(res, 'Public base URL is not configured.');
  }

  try {
    const auth = await verifyRequestAuth(req, tokenFromBody);
    if (!auth.ok) {
      return unauthorized(res, auth.message || 'Unauthorized.');
    }

    const { tier, amountRub } = getTierPriceRub(tierRaw);
    const paymentRef = adminDb.ref('payments').push();
    const paymentId = paymentRef.key;
    if (!paymentId) {
      throw new Error('Failed to generate payment id.');
    }

    const createdAt = Date.now();
    await paymentRef.set({
      userId: auth.uid,
      tier,
      amount: amountRub,
      status: 'pending',
      provider: 'yookassa',
      providerTxId: null,
      returnUrl,
      createdAt,
      updatedAt: createdAt
    });
    await adminDb.ref(`entitlements/${auth.uid}`).update({
      state: 'pending',
      source: 'payment_create',
      updatedAt: createdAt
    });

    await writeAuditLog('payment_create_requested', {
      ip,
      uid: auth.uid,
      paymentId,
      tier,
      amount: amountRub
    });

    const provider = await createYooKassaPayment({
      paymentId,
      userId: auth.uid,
      email: auth.email,
      tier,
      amountRub,
      returnUrl
    });

    if (!provider.ok) {
      await paymentRef.update({
        status: 'failed',
        providerError: provider.message || 'provider_create_failed',
        updatedAt: Date.now()
      });

      await writeAuditLog('payment_create_failed', {
        ip,
        uid: auth.uid,
        paymentId,
        reason: provider.message || 'provider_error'
      });

      return serverError(res, 'Failed to create payment.', provider.message);
    }

    const providerPayment = provider.payment || {};
    const confirmationUrl = providerPayment?.confirmation?.confirmation_url || '';
    if (!confirmationUrl) {
      await paymentRef.update({
        status: 'failed',
        providerError: 'missing_confirmation_url',
        updatedAt: Date.now()
      });
      return serverError(res, 'Payment provider did not return confirmation URL.');
    }

    await paymentRef.update({
      providerTxId: providerPayment.id || null,
      providerStatus: String(providerPayment.status || 'pending'),
      status: normalizeYooKassaStatus(providerPayment.status),
      confirmationUrl,
      providerPayload: {
        id: providerPayment.id || null,
        paid: providerPayment.paid === true,
        test: providerPayment.test === true
      },
      expiresAt: providerPayment.expires_at ? Date.parse(providerPayment.expires_at) : null,
      updatedAt: Date.now()
    });

    await writeAuditLog('payment_create_success', {
      ip,
      uid: auth.uid,
      paymentId,
      providerTxId: providerPayment.id || null
    });

    return res.status(200).json({
      ok: true,
      paymentId,
      confirmationUrl,
      expiresAt: providerPayment.expires_at ? Date.parse(providerPayment.expires_at) : null
    });
  } catch (error) {
    console.error('payments/create error:', error);
    return serverError(res, 'Internal server error.', error?.message);
  }
}
