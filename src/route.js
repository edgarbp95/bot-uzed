'use strict';

/**
 * src/route.js — Router de entrada por modo del bot.
 *
 * Lee org_settings.whatsapp_bot_mode (set por la org en el panel) y despacha:
 *
 *   - 'ai'       → agent.js (LLM, flujo actual intacto). Solo soporta texto.
 *   - 'scripted' → scripted/index.js (menús, botones, list messages, flows).
 *                  Soporta text + interactive replies + flow responses.
 *   - 'hybrid'   → (placeholder para tanda futura) actualmente cae a 'ai'.
 *   - 'off'      → el bot no responde; guarda el inbound para que el panel
 *                  lo vea y listo.
 *   - 'unknown'  → canal no registrado → ignorado.
 *
 * Cada handler hace su propio lookup/save — este router solo dispatchea.
 * La razón: mantener 'ai' y 'scripted' desacoplados entre sí.
 */

const { supabase } = require('./supabase');
const { handleIncomingMessage } = require('./agent');
const { handleScriptedMessage } = require('./scripted');
const { sendMessage } = require('./whatsapp');

// Cache corto del mode por canal (evita 2 queries por cada mensaje).
// Si staff cambia el mode desde el panel, los siguientes mensajes tardan
// hasta MODE_CACHE_TTL_MS en reflejar el cambio.
const MODE_CACHE_TTL_MS = 30 * 1000;
const _modeCache = new Map(); // phoneNumberId → { mode, orgId, expiresAt }

async function resolveBotMode(phoneNumberId) {
  const now = Date.now();
  const hit = _modeCache.get(phoneNumberId);
  if (hit && hit.expiresAt > now) {
    return { mode: hit.mode, organizationId: hit.orgId };
  }

  const { data: channel } = await supabase
    .from('organization_whatsapp_channels')
    .select('organization_id')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .maybeSingle();

  if (!channel) {
    _modeCache.set(phoneNumberId, { mode: 'unknown', orgId: null, expiresAt: now + MODE_CACHE_TTL_MS });
    return { mode: 'unknown', organizationId: null };
  }

  const { data: settings } = await supabase
    .from('org_settings')
    .select('whatsapp_bot_mode')
    .eq('org_id', channel.organization_id)
    .maybeSingle();

  const mode = settings?.whatsapp_bot_mode || 'ai';
  _modeCache.set(phoneNumberId, {
    mode,
    orgId: channel.organization_id,
    expiresAt: now + MODE_CACHE_TTL_MS,
  });
  return { mode, organizationId: channel.organization_id };
}

/**
 * Guarda el inbound y nada más. Se usa para mode='off'.
 * Hacemos el lookup completo y el save vía RPC + insert, replicando la
 * lógica de agent.js / scripted/index.js (sin tocarlos).
 */
async function saveInboundOnly({ phoneNumberId, from, message, messageId, profileName }) {
  const { data: channel } = await supabase
    .from('organization_whatsapp_channels')
    .select('id, organization_id, branch_id')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .maybeSingle();
  if (!channel) return;

  const { data: conversationId } = await supabase.rpc('wa_upsert_conversation', {
    p_channel_id: channel.id,
    p_organization_id: channel.organization_id,
    p_branch_id: channel.branch_id,
    p_whatsapp: from,
    p_profile_name: profileName || null,
  });
  if (!conversationId) return;

  const preview = message?.type === 'text'
    ? String(message.text?.body || '')
    : `[${message?.type || 'unknown'}]`;

  await supabase.from('whatsapp_messages').insert({
    organization_id: channel.organization_id,
    branch_id: channel.branch_id,
    conversation_id: conversationId,
    channel_id: channel.id,
    patient_id: null,
    direction: 'inbound',
    author: 'patient',
    content_type: 'text',
    content: preview,
    wamid: messageId || null,
  });

  // Incrementar unread_count — si el staff tiene abierto el panel, lo ve.
  const { data: cur } = await supabase
    .from('whatsapp_conversations')
    .select('unread_count')
    .eq('id', conversationId)
    .maybeSingle();

  await supabase
    .from('whatsapp_conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: preview.slice(0, 200),
      unread_count: (cur?.unread_count || 0) + 1,
    })
    .eq('id', conversationId);
}

/**
 * Entry point único del webhook. server.js le pasa el mensaje crudo y
 * route.js decide qué hacer.
 */
async function routeIncomingMessage({
  phoneNumberId,
  from,
  message,
  messageId,
  profileName,
  accessToken,
}) {
  const { mode } = await resolveBotMode(phoneNumberId);

  if (mode === 'unknown') {
    console.warn(`[route] phone_number_id ${phoneNumberId} sin canal activo — ignorado.`);
    return;
  }

  if (mode === 'off') {
    await saveInboundOnly({ phoneNumberId, from, message, messageId, profileName });
    return;
  }

  if (mode === 'scripted') {
    return handleScriptedMessage({
      phoneNumberId, from, message, messageId, profileName, accessToken,
    });
  }

  // mode === 'ai' (default) o 'hybrid' (hasta que se implemente el fallback)
  // El agente IA solo soporta texto. Multimedia / interactive replies:
  // respondemos que solo aceptamos texto (replicando el comportamiento
  // anterior de server.js) y además guardamos el inbound.
  if (message?.type !== 'text') {
    await saveInboundOnly({ phoneNumberId, from, message, messageId, profileName });
    try {
      await sendMessage({
        phoneNumberId,
        accessToken,
        to: from,
        text: 'Por ahora solo puedo procesar mensajes de texto. ¿Me cuentas en palabras en qué te puedo ayudar?',
      });
    } catch (err) {
      console.error('[route] unsupported-type reply failed:', err?.message);
    }
    return;
  }

  return handleIncomingMessage({
    phoneNumberId,
    from,
    text: message.text.body,
    messageId,
    profileName,
    accessToken,
  });
}

module.exports = { routeIncomingMessage, resolveBotMode, saveInboundOnly };
