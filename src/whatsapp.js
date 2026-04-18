'use strict';

/**
 * Cliente HTTP de WhatsApp Cloud API.
 *
 * Multi-tenant: cada llamada recibe el phone_number_id y access_token
 * a usar. Si no se pasan, fallback a las env vars globales (modo "managed"
 * de Uzed). En modo "self_service" la org provee sus propios credenciales.
 */

const crypto = require('crypto');

const WHATSAPP_API_VERSION = 'v21.0';
const WHATSAPP_API_URL = `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;

function resolveCreds({ phoneNumberId, accessToken }) {
  return {
    phoneNumberId: phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: accessToken || process.env.WHATSAPP_ACCESS_TOKEN,
  };
}

async function sendMessage({ phoneNumberId, accessToken, to, text }) {
  const creds = resolveCreds({ phoneNumberId, accessToken });
  if (!creds.phoneNumberId || !creds.accessToken) {
    throw new Error('WhatsApp creds missing (phone_number_id / access_token)');
  }

  const url = `${WHATSAPP_API_URL}/${creds.phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WhatsApp API error ${response.status}: ${errorText}`);
  }
  return response.json();
}

async function markAsRead({ phoneNumberId, accessToken, messageId }) {
  if (!messageId) return;
  const creds = resolveCreds({ phoneNumberId, accessToken });
  if (!creds.phoneNumberId || !creds.accessToken) return;

  try {
    const url = `${WHATSAPP_API_URL}/${creds.phoneNumberId}/messages`;
    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch (err) {
    console.error('[wa] markAsRead failed:', err.message);
  }
}

/**
 * Verifica firma HMAC del webhook con el app_secret pasado (o el global).
 *
 * En multi-tenant managed, todas las orgs usan la app de Uzed → un único
 * APP_SECRET global. En self_service, podríamos resolver el app_secret por
 * canal — pero como Meta entrega la firma a nivel de app (no por número),
 * mantenemos el app_secret global por ahora.
 */
function verifyWebhookSignature(rawBody, signatureHeader, appSecretOverride) {
  const appSecret = appSecretOverride || process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    console.warn('[wa] WHATSAPP_APP_SECRET no seteado — saltando verificación (DEV).');
    return true;
  }
  if (!signatureHeader) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { sendMessage, markAsRead, verifyWebhookSignature };
