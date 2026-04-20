'use strict';

/**
 * src/scripted/index.js — Dispatcher del bot scripted.
 *
 * Reemplaza al agent loop LLM cuando org_settings.whatsapp_bot_mode = 'scripted'.
 *
 * Flujo:
 *   1. Normaliza el mensaje entrante (text / button / list / flow) en un
 *      objeto `input` uniforme.
 *   2. Carga estado (scripted_step + scripted_state) — si expiró, resetea.
 *   3. Maneja escape universal ("menú", "salir", etc.) → step 'menu'.
 *   4. Llama al handler del step actual. Si pide transición, vuelve a
 *      llamar al nuevo step con input=null (para que muestre su prompt).
 *      Máx 6 transiciones por turno (evita loops).
 *   5. Envía todos los mensajes acumulados en orden (text via sendMessage,
 *      interactive via sendInteractive).
 *   6. Persiste el nuevo step/state, o los limpia si el flujo terminó.
 *
 * IMPORTANTE: Este módulo no depende de agent.js. Hace su propio lookup
 * de canal + upsert de conversación + save de mensajes, para que el
 * router en server.js pueda enrutar a este o al LLM sin acoplarlos.
 */

const { DateTime } = require('luxon');
const { supabase } = require('../supabase');
const { sendMessage, sendInteractive, markAsRead } = require('../whatsapp');

const {
  loadScriptedState,
  saveScriptedState,
  clearScriptedState,
} = require('./state');

// Steps
const menuStep = require('./steps/menu');
const agendarSteps = require('./steps/agendar');
const reprogramarSteps = require('./steps/reprogramar');
const cancelarSteps = require('./steps/cancelar');
const misCitasStep = require('./steps/misCitas');
const escalarStep = require('./steps/escalar');

const STEPS = {
  ...menuStep.handlers,
  ...agendarSteps.handlers,
  ...reprogramarSteps.handlers,
  ...cancelarSteps.handlers,
  ...misCitasStep.handlers,
  ...escalarStep.handlers,
};

const DEFAULT_TZ = 'America/Bogota';
const MAX_TRANSITIONS_PER_TURN = 6;

// ============================================================
// Shared helpers (duplicados mínimos con agent.js para evitar acoplamiento)
// ============================================================

async function lookupChannelByPhoneNumberId(phoneNumberId) {
  const { data, error } = await supabase
    .from('organization_whatsapp_channels')
    .select('id, organization_id, branch_id, display_name, display_phone_number, is_active')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadOrgContext(organizationId) {
  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, service_line, country')
    .eq('id', organizationId)
    .maybeSingle();
  const { data: settings } = await supabase
    .from('org_settings')
    .select('timezone')
    .eq('org_id', organizationId)
    .maybeSingle();
  return {
    name: org?.name || 'la clínica',
    serviceLine: org?.service_line || 'medical',
    timezone: settings?.timezone || DEFAULT_TZ,
    country: org?.country || 'CO',
  };
}

async function upsertConversation({ channelId, organizationId, branchId, whatsapp, profileName }) {
  const { data, error } = await supabase.rpc('wa_upsert_conversation', {
    p_channel_id: channelId,
    p_organization_id: organizationId,
    p_branch_id: branchId,
    p_whatsapp: whatsapp,
    p_profile_name: profileName || null,
  });
  if (error) throw error;
  return data;
}

async function getConversation(conversationId) {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .select('id, status, patient_id')
    .eq('id', conversationId)
    .maybeSingle();
  return data;
}

async function saveMessage({
  organizationId,
  branchId,
  conversationId,
  channelId,
  patientId,
  direction,
  author,
  content,
  wamid,
  error,
}) {
  await supabase.from('whatsapp_messages').insert({
    organization_id: organizationId,
    branch_id: branchId,
    conversation_id: conversationId,
    channel_id: channelId,
    patient_id: patientId || null,
    direction,
    author,
    content_type: 'text',
    content,
    wamid: wamid || null,
    error: error || null,
  });

  const patch = {
    last_message_at: new Date().toISOString(),
    last_message_preview: (content || '').slice(0, 200),
  };

  if (direction === 'inbound') {
    const { data: cur } = await supabase
      .from('whatsapp_conversations')
      .select('unread_count')
      .eq('id', conversationId)
      .maybeSingle();
    patch.unread_count = (cur?.unread_count || 0) + 1;
  }

  await supabase
    .from('whatsapp_conversations')
    .update(patch)
    .eq('id', conversationId);
}

// ============================================================
// Normalización del mensaje entrante
// ============================================================

/**
 * Convierte un payload de WhatsApp Cloud API en el objeto `input`
 * que consumen los step handlers.
 *
 * Retorna null si el tipo no es soportado (ej. multimedia, audio).
 */
function normalizeIncoming(message) {
  if (!message) return null;

  if (message.type === 'text') {
    return {
      type: 'text',
      text: String(message.text?.body || ''),
      _preview: String(message.text?.body || ''),
    };
  }

  if (message.type === 'interactive') {
    const it = message.interactive || {};
    if (it.type === 'button_reply') {
      return {
        type: 'button',
        id: it.button_reply?.id || null,
        title: it.button_reply?.title || null,
        _preview: `[botón] ${it.button_reply?.title || it.button_reply?.id || ''}`,
      };
    }
    if (it.type === 'list_reply') {
      return {
        type: 'list',
        id: it.list_reply?.id || null,
        title: it.list_reply?.title || null,
        description: it.list_reply?.description || null,
        _preview: `[lista] ${it.list_reply?.title || it.list_reply?.id || ''}`,
      };
    }
    if (it.type === 'nfm_reply') {
      // Respuesta de WhatsApp Flow (formulario)
      let data = null;
      try {
        data = JSON.parse(it.nfm_reply?.response_json || '{}');
      } catch {
        data = null;
      }
      return {
        type: 'flow',
        flowResponse: data,
        _preview: '[flow] completado',
      };
    }
  }

  return null;
}

// ============================================================
// Escape universal
// ============================================================

const ESCAPE_WORDS = /^\s*(menu|menú|salir|inicio|start|\/menu|\/salir|volver)\s*$/i;

function isEscapeInput(input) {
  return input?.type === 'text' && ESCAPE_WORDS.test(String(input.text || ''));
}

// ============================================================
// Envío de mensajes (text / interactive)
// ============================================================

async function sendMessageWrapper({ phoneNumberId, accessToken, to, message }) {
  if (message.kind === 'text') {
    return sendMessage({ phoneNumberId, accessToken, to, text: message.text });
  }
  if (message.kind === 'interactive') {
    return sendInteractive({
      phoneNumberId,
      accessToken,
      to,
      interactive: message.interactive,
    });
  }
  throw new Error(`unknown message.kind: ${message.kind}`);
}

function messagePreview(message) {
  if (message.kind === 'text') return message.text?.slice(0, 200) || '';
  if (message.kind === 'interactive') {
    const body = message.interactive?.body?.text || '';
    const type = message.interactive?.type || 'interactive';
    return `[${type}] ${body.slice(0, 180)}`;
  }
  return '';
}

// ============================================================
// Dispatcher
// ============================================================

/**
 * Corre la máquina de estados para este turno.
 *
 * @param {object} ctx
 * @param {object} input - normalizado, o null para arrancar en 'menu'
 * @param {string|null} step - step actual (null o 'menu' si es primer mensaje)
 * @param {object} state
 * @returns {Promise<{messages: Array, nextStep: string|null, nextState: object, terminal: boolean}>}
 */
async function runDispatch(ctx, input, step, state) {
  // Si el input es escape universal, forzamos al menú sin importar el step.
  if (isEscapeInput(input)) {
    step = 'menu';
    state = {};
    input = null;
  }

  // Fallback: si no hay step (primer mensaje o estado expirado), arrancamos en menú.
  if (!step || !STEPS[step]) {
    step = 'menu';
    state = state || {};
    input = null;
  }

  const allMessages = [];
  let terminal = false;

  for (let i = 0; i < MAX_TRANSITIONS_PER_TURN; i++) {
    const handler = STEPS[step];
    if (!handler) {
      // Step desconocido → fallback a menú
      step = 'menu';
      state = {};
      input = null;
      continue;
    }

    let result;
    try {
      result = await handler(ctx, input, state || {});
    } catch (err) {
      console.error(`[scripted] step ${step} threw:`, err?.message, err?.stack);
      allMessages.push({
        kind: 'text',
        text: 'Uy, se me complicó algo del lado técnico. ¿Podés escribir "menú" así arrancamos de nuevo?',
      });
      terminal = true;
      step = null;
      state = {};
      break;
    }

    const msgs = result?.messages || [];
    allMessages.push(...msgs);

    const t = result?.transition;
    const newState = result?.state !== undefined ? result.state : state;

    if (t === 'end') {
      terminal = true;
      step = null;
      state = {};
      break;
    }

    if (t === 'stay' || !t) {
      state = newState;
      // No transicionamos — esperamos input próximo en este step.
      break;
    }

    if (typeof t === 'object' && t.to) {
      step = t.to;
      state = t.state !== undefined ? t.state : newState;
      input = null;
      continue;
    }

    // Caso raro: transition con shape desconocido → stay
    state = newState;
    break;
  }

  return { messages: allMessages, nextStep: step, nextState: state, terminal };
}

// ============================================================
// Entrypoint público
// ============================================================

/**
 * Igual que handleIncomingMessage de agent.js, pero para el modo scripted.
 * Recibe el mensaje entrante crudo de Meta y lo procesa end-to-end.
 *
 * Firma alineada a la del agente IA — server.js puede pasar el objeto
 * message completo sin pre-procesar.
 */
async function handleScriptedMessage({
  phoneNumberId,
  from,
  message,         // payload completo de Meta (reemplaza a `text`)
  messageId,
  profileName,
  accessToken,
}) {
  let _step = 'init';
  let conversationId = null;
  let channel = null;

  try {
    _step = 'lookupChannel';
    channel = await lookupChannelByPhoneNumberId(phoneNumberId);
    if (!channel) {
      console.warn(`[scripted] phone_number_id ${phoneNumberId} sin canal activo.`);
      return;
    }

    markAsRead({ phoneNumberId, accessToken, messageId }).catch(() => {});

    _step = 'loadOrgContext';
    const orgInfo = await loadOrgContext(channel.organization_id);

    _step = 'upsertConversation';
    conversationId = await upsertConversation({
      channelId: channel.id,
      organizationId: channel.organization_id,
      branchId: channel.branch_id,
      whatsapp: from,
      profileName,
    });

    _step = 'getConversation';
    const conv = await getConversation(conversationId);

    _step = 'normalizeIncoming';
    const input = normalizeIncoming(message);
    const inboundPreview = input?._preview || (message?.type ? `[${message.type}]` : '[unknown]');

    _step = 'saveInbound';
    await saveMessage({
      organizationId: channel.organization_id,
      branchId: channel.branch_id,
      conversationId,
      channelId: channel.id,
      patientId: conv?.patient_id,
      direction: 'inbound',
      author: 'patient',
      content: inboundPreview,
      wamid: messageId,
    });

    // Si está en handoff humano, no respondemos con bot.
    if (conv?.status === 'human_handoff') {
      console.log(`[scripted] conv ${conversationId} en handoff — no respondo.`);
      return;
    }

    // Tipos no soportados (multimedia, audio, ...) → responder amablemente.
    if (!input) {
      await sendMessage({
        phoneNumberId,
        accessToken,
        to: from,
        text: 'Disculpá, por ahora solo puedo procesar texto y opciones del menú. Si querés, escribí "menú" y te muestro todo lo que puedo ayudarte.',
      });
      return;
    }

    _step = 'loadScriptedState';
    const { step: currentStep, state: currentState } = await loadScriptedState(conversationId);

    _step = 'runDispatch';
    const ctx = {
      organizationId: channel.organization_id,
      branchId: channel.branch_id,
      serviceLine: orgInfo.serviceLine,
      timezone: orgInfo.timezone,
      whatsapp: from,
      conversationId,
      orgName: orgInfo.name,
    };

    const { messages, nextStep, nextState, terminal } = await runDispatch(
      ctx,
      input,
      currentStep,
      currentState,
    );

    _step = 'sendMessages';
    for (const msg of messages || []) {
      try {
        await sendMessageWrapper({
          phoneNumberId,
          accessToken,
          to: from,
          message: msg,
        });
      } catch (sendErr) {
        console.error('[scripted] send failed:', sendErr?.message);
      }
      await saveMessage({
        organizationId: channel.organization_id,
        branchId: channel.branch_id,
        conversationId,
        channelId: channel.id,
        patientId: conv?.patient_id,
        direction: 'outbound',
        author: 'bot',
        content: messagePreview(msg),
        wamid: null,
      });
    }

    _step = 'saveScriptedState';
    if (terminal) {
      await clearScriptedState(conversationId);
    } else {
      await saveScriptedState(conversationId, nextStep, nextState);
    }
  } catch (error) {
    console.error(`[scripted] error in ${_step}:`, error?.message, error?.stack);
    // Best-effort: intentamos avisar al paciente que algo falló.
    try {
      await sendMessage({
        phoneNumberId,
        accessToken,
        to: from,
        text: 'Uy, tuve un problema procesando tu mensaje. ¿Podés escribir "menú" así arrancamos de nuevo?',
      });
    } catch {}

    if (conversationId) {
      try {
        await saveMessage({
          organizationId: channel?.organization_id,
          branchId: channel?.branch_id,
          conversationId,
          channelId: channel?.id,
          patientId: null,
          direction: 'outbound',
          author: 'bot',
          content: `[scripted error: ${_step}] ${(error?.message || '').slice(0, 200)}`,
          wamid: null,
          error: (error?.message || String(error)).slice(0, 1000),
        });
      } catch {}
    }
  }
}

module.exports = {
  handleScriptedMessage,
  // expuestos para tests
  _internal: {
    normalizeIncoming,
    runDispatch,
    STEPS,
  },
};
