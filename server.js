'use strict';

require('dotenv').config();
const Fastify = require('fastify');
const { handleIncomingMessage } = require('./src/agent');
const { verifyWebhookSignature } = require('./src/whatsapp');

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
  },
  // We need the raw body to validate Meta's webhook signature
  bodyLimit: 1048576, // 1MB
});

// Capture raw body for signature verification
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
fastify.get('/', async () => {
  return { status: 'ok', service: 'bot-uzed', time: new Date().toISOString() };
});

// WhatsApp webhook verification (Meta calls this once via GET when you save the webhook URL)
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

// WhatsApp incoming messages
fastify.post('/webhook', async (request, reply) => {
  const signature = request.headers['x-hub-signature-256'];
  const rawBody = request.rawBody || '';

  if (!verifyWebhookSignature(rawBody, signature)) {
    fastify.log.warn('Invalid webhook signature');
    return reply.code(403).send('Forbidden');
  }

  // Acknowledge Meta within 20s or they'll retry
  reply.code(200).send('OK');

  // Process asynchronously after responding
  setImmediate(async () => {
    try {
      const body = request.body;
      if (body.object !== 'whatsapp_business_account') return;

      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== 'messages') continue;
          const value = change.value || {};
          const messages = value.messages || [];
          const contacts = value.contacts || [];

          for (const message of messages) {
            const contact = contacts.find((c) => c.wa_id === message.from) || {};
            const profileName = contact.profile && contact.profile.name;

            if (message.type === 'text') {
              await handleIncomingMessage({
                from: message.from,
                text: message.text.body,
                messageId: message.id,
                profileName,
              });
            } else {
              // Unsupported message type (image, audio, etc.)
              const { sendMessage } = require('./src/whatsapp');
              await sendMessage(
                message.from,
                'Por ahora solo puedo procesar mensajes de texto. ¿Me cuentas en palabras en qué te puedo ayudar?'
              );
            }
          }
        }
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'Error processing webhook');
    }
  });
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