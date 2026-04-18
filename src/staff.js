'use strict';

/**
 * Endpoint POST /staff/send — usado por el panel Angular.
 *
 * Flujo:
 *   1. Valida el JWT de Supabase (Authorization: Bearer <jwt>)
 *   2. Extrae user_id del JWT
 *   3. Verifica que el user es miembro activo de la org de la conversación
 *   4. Envía el mensaje via WhatsApp Cloud API
 *   5. Guarda en whatsapp_messages con author='staff'
 *   6. Actualiza last_message_at + preview (y unread_count NO — es outbound)
 *
 * Seguridad: el token de WhatsApp NUNCA sale del servidor. El panel solo
 * pasa un JWT firmado por Supabase, que validamos con supabase.auth.getUser(jwt).
 */

const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('./supabase'); // service_role, para operaciones privilegiadas
const { sendMessage } = require('./whatsapp');

// Cliente "anon" que usamos solo para validar JWTs
let _authClient = null;
function authClient() {
  if (!_authClient) {
    _authClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return _authClient;
}

async function validateJwt(jwt) {
  if (!jwt) return null;
  const { data, error } = await authClient().auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user;
}

/**
 * Verifica que el userId es miembro activo de organizationId.
 * Usa memberships (tabla estándar de uzed-health).
 */
async function isMemberOfOrg(userId, organizationId) {
  const { data } = await supabase
    .from('memberships')
    .select('id')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .maybeSingle();
  return !!data;
}

async function loadConversation(conversationId) {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .select(
      'id, organization_id, branch_id, channel_id, whatsapp, patient_id, status'
    )
    .eq('id', conversationId)
    .maybeSingle();
  return data;
}

async function loadChannel(channelId) {
  const { data } = await supabase
    .from('organization_whatsapp_channels')
    .select('id, organization_id, phone_number_id, is_active, provisioning_mode')
    .eq('id', channelId)
    .maybeSingle();
  return data;
}

/**
 * Handler principal. Recibe el body validado y el user ya autenticado.
 * Retorna { ok, data?, error?, status }
 */
async function handleStaffSend({ user, conversationId, text }) {
  if (!text || typeof text !== 'string' || !text.trim()) {
    return { ok: false, status: 400, error: 'text_required' };
  }
  if (text.length > 4096) {
    return { ok: false, status: 400, error: 'text_too_long' };
  }

  const conv = await loadConversation(conversationId);
  if (!conv) {
    return { ok: false, status: 404, error: 'conversation_not_found' };
  }

  const isMember = await isMemberOfOrg(user.id, conv.organization_id);
  if (!isMember) {
    return { ok: false, status: 403, error: 'not_a_member' };
  }

  const channel = await loadChannel(conv.channel_id);
  if (!channel || !channel.is_active) {
    return { ok: false, status: 409, error: 'channel_inactive' };
  }

  // Enviar por WhatsApp Cloud API
  let sent;
  try {
    sent = await sendMessage({
      phoneNumberId: channel.phone_number_id,
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
      to: conv.whatsapp,
      text: text.trim(),
    });
  } catch (err) {
    console.error('[staff/send] WhatsApp API error:', err.message);
    // Guardamos el error también en la DB para auditoría
    await supabase.from('whatsapp_messages').insert({
      organization_id: conv.organization_id,
      branch_id: conv.branch_id,
      conversation_id: conv.id,
      channel_id: conv.channel_id,
      patient_id: conv.patient_id,
      direction: 'outbound',
      author: 'staff',
      staff_user_id: user.id,
      content_type: 'text',
      content: text.trim(),
      error: err.message?.slice(0, 4000) || 'WhatsApp API error',
    });
    return { ok: false, status: 502, error: 'whatsapp_api_error', detail: err.message };
  }

  const wamid = sent?.messages?.[0]?.id;

  // Insertar mensaje outbound (author='staff')
  const { data: inserted, error: insertErr } = await supabase
    .from('whatsapp_messages')
    .insert({
      organization_id: conv.organization_id,
      branch_id: conv.branch_id,
      conversation_id: conv.id,
      channel_id: conv.channel_id,
      patient_id: conv.patient_id,
      direction: 'outbound',
      author: 'staff',
      staff_user_id: user.id,
      content_type: 'text',
      content: text.trim(),
      wamid,
    })
    .select('id, created_at, direction, author, content, wamid')
    .single();

  if (insertErr) {
    console.error('[staff/send] insert message error:', insertErr);
    return { ok: false, status: 500, error: 'db_insert_failed' };
  }

  // Actualizar preview + last_message_at
  await supabase
    .from('whatsapp_conversations')
    .update({
      last_message_at: new Date().toISOString(),
      last_message_preview: text.trim().slice(0, 200),
    })
    .eq('id', conv.id);

  return { ok: true, status: 200, data: { message: inserted } };
}

/**
 * Endpoint POST /staff/takeover — pone la conversación en human_handoff
 * o la devuelve al bot. Body: { conversation_id, status: 'human_handoff' | 'active' }
 */
async function handleStaffSetStatus({ user, conversationId, status }) {
  if (!['human_handoff', 'active', 'closed'].includes(status)) {
    return { ok: false, status: 400, error: 'invalid_status' };
  }

  const conv = await loadConversation(conversationId);
  if (!conv) return { ok: false, status: 404, error: 'conversation_not_found' };

  const isMember = await isMemberOfOrg(user.id, conv.organization_id);
  if (!isMember) return { ok: false, status: 403, error: 'not_a_member' };

  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .update({
      status,
      unread_count: status === 'active' || status === 'human_handoff' ? undefined : 0,
    })
    .eq('id', conversationId)
    .select('id, status')
    .single();

  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, status: 200, data };
}

/**
 * Endpoint POST /staff/mark-read — pone unread_count=0 en la conversación.
 * Útil cuando el staff abre el hilo.
 */
async function handleStaffMarkRead({ user, conversationId }) {
  const conv = await loadConversation(conversationId);
  if (!conv) return { ok: false, status: 404, error: 'conversation_not_found' };

  const isMember = await isMemberOfOrg(user.id, conv.organization_id);
  if (!isMember) return { ok: false, status: 403, error: 'not_a_member' };

  const { error } = await supabase
    .from('whatsapp_conversations')
    .update({ unread_count: 0 })
    .eq('id', conversationId);
  if (error) return { ok: false, status: 500, error: error.message };
  return { ok: true, status: 200, data: { ok: true } };
}

module.exports = {
  validateJwt,
  handleStaffSend,
  handleStaffSetStatus,
  handleStaffMarkRead,
};
