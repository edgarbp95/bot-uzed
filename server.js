'use strict';

require('dotenv').config();
const Fastify = require('fastify');
const { handleIncomingMessage } = require('./src/agent');
const { sendMessage, verifyWebhookSignature } = require('./src/whatsapp');
const {
  validateJwt,
  handleStaffSend,
  handleStaffSetStatus,
  handleStaffMarkRead,
} = require('./src/staff');

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 1048576, // 1MB
});

// ── CORS para las rutas /staff/* (panel Angular) ──
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

fastify.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin;
  if (!request.url.startsWith('/staff')) return;

  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    reply.header('Access-Control-Max-Age', '86400');
  }
  if (request.method === 'OPTIONS') {
    return reply.code(204).send();
  }
});

// Capturar raw body para validar la firma HMAC de Meta
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (req, body, done) => {
    try {
      const json = JSON.parse(body);
      req.rawBody = body;
      done(null, json);
    } catch (err) {
      done(err, undefined);
    }
  }
);

// Health check
fastify.get('/', async () => ({
  status: 'ok',
  service: 'bot-uzed',
  time: new Date().toISOString(),
}));

// GET /webhook — verificación one-time de Meta
fastify.get('/webhook', async (request, reply) => {
  const mode = request.query['hub.mode'];
  const token = request.query['hub.verify_token'];
  const challenge = request.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    fastify.log.info('WhatsApp webhook verified');
    return reply.code(200).send(challenge);
  }
  fastify.log.warn({ mode, token }, 'Invalid webhook verification');
  return reply.code(403).send('Forbidden');
});

// POST /webhook — mensajes entrantes
fastify.post('/webhook', async (request, reply) => {
  const signature = request.headers['x-hub-signature-256'];
  const rawBody = request.rawBody || '';

  if (!verifyWebhookSignature(rawBody, signature)) {
    fastify.log.warn('Invalid webhook signature');
    return reply.code(403).send('Forbidden');
  }

  // Meta espera 200 en <20s — procesamos async
  reply.code(200).send('OK');

  setImmediate(async () => {
    try {
      const body = request.body;
      if (body.object !== 'whatsapp_business_account') return;

      // Token global (modo managed). En self_service lo resolveremos por canal dentro del agent.
      const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== 'messages') continue;
          const value = change.value || {};
          const phoneNumberId = value.metadata?.phone_number_id;
          if (!phoneNumberId) continue;

          const messages = value.messages || [];
          const contacts = value.contacts || [];

          for (const message of messages) {
            const contact = contacts.find((c) => c.wa_id === message.from) || {};
            const profileName = contact.profile?.name;

            if (message.type === 'text') {
              await handleIncomingMessage({
                phoneNumberId,
                from: message.from,
                text: message.text.body,
                messageId: message.id,
                profileName,
                accessToken,
              });
            } else {
              // Multimedia aún no soportado — responder amablemente
              try {
                await sendMessage({
                  phoneNumberId,
                  accessToken,
                  to: message.from,
                  text: 'Por ahora solo puedo procesar mensajes de texto. ¿Me cuentas en palabras en qué te puedo ayudar?',
                });
              } catch (e) {
                fastify.log.error({ err: e }, 'Failed to send unsupported-type reply');
              }
            }
          }
        }
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'Error processing webhook');
    }
  });
});

// ============================================================
// /staff/* — endpoints para el panel Angular de uzed-health
// ============================================================

/** Extrae y valida el JWT del header Authorization: Bearer <jwt>. */
async function requireAuth(request, reply) {
  const auth = request.headers['authorization'] || request.headers['Authorization'];
  const jwt = typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice(7).trim()
    : null;
  if (!jwt) {
    reply.code(401).send({ error: 'missing_bearer_token' });
    return null;
  }
  const user = await validateJwt(jwt);
  if (!user) {
    reply.code(401).send({ error: 'invalid_token' });
    return null;
  }
  return user;
}

fastify.post('/staff/send', async (request, reply) => {
  const user = await requireAuth(request, reply);
  if (!user) return;

  const { conversation_id: conversationId, text } = request.body || {};
  const result = await handleStaffSend({ user, conversationId, text });
  reply.code(result.status).send(result.ok ? result.data : { error: result.error, detail: result.detail });
});

fastify.post('/staff/set-status', async (request, reply) => {
  const user = await requireAuth(request, reply);
  if (!user) return;

  const { conversation_id: conversationId, status } = request.body || {};
  const result = await handleStaffSetStatus({ user, conversationId, status });
  reply.code(result.status).send(result.ok ? result.data : { error: result.error });
});

fastify.post('/staff/mark-read', async (request, reply) => {
  const user = await requireAuth(request, reply);
  if (!user) return;

  const { conversation_id: conversationId } = request.body || {};
  const result = await handleStaffMarkRead({ user, conversationId });
  reply.code(result.status).send(result.ok ? result.data : { error: result.error });
});

const start = async () => {
  try {
    const port = process.env.PORT || 3000;
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Bot Uzed listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
