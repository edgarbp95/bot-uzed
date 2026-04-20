'use strict';

/**
 * src/scripted/state.js
 *
 * Manejo del estado de la máquina de flujos del bot scripted. Persistido
 * en whatsapp_conversations (scripted_step, scripted_state, scripted_updated_at).
 *
 * Convenciones de naming de steps (string con namespace por flujo):
 *   'menu'                          → menú principal (inicio de cualquier flujo)
 *   'agendar.especialidad'
 *   'agendar.tipo'
 *   'agendar.profesional'
 *   'agendar.dia'
 *   'agendar.hora'
 *   'agendar.paciente_confirmar'   → "¿sos vos?" si hay paciente matcheado por wa
 *   'agendar.registro.first_name'  → pide nombre
 *   'agendar.registro.last_name'
 *   'agendar.registro.birth_date'
 *   'agendar.registro.city'
 *   'agendar.registro.email'
 *   'agendar.registro.flow'         → variante con WhatsApp Flow, espera nfm_reply
 *   'agendar.confirmacion'          → confirma todo antes del INSERT
 *   'reprogramar.elegir_cita'
 *   'reprogramar.dia'
 *   'reprogramar.hora'
 *   'reprogramar.confirmacion'
 *   'cancelar.elegir_cita'
 *   'cancelar.confirmacion'
 *   'ver_citas'                     → terminal (solo muestra)
 *   'escalar.confirmacion'
 *
 * Cuando un flujo termina (agendada, cancelada, etc.) limpiamos el estado
 * con clearScriptedState(). Al primer mensaje nuevo, el router arranca en
 * 'menu'.
 */

const { supabase } = require('../supabase');

// Después de 1 hora sin actividad, descartamos el estado — evita que una
// conversación dejada a medias ayer confunda al paciente hoy.
const SCRIPTED_STATE_TTL_MS = 60 * 60 * 1000;

/**
 * Carga el estado scripted actual de la conversación.
 * Si está expirado (> TTL), devuelve estado vacío (sin resetear en DB —
 * el siguiente save lo sobreescribe igual).
 */
async function loadScriptedState(conversationId) {
  if (!conversationId) {
    return { step: null, state: {}, expired: false };
  }

  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select('scripted_step, scripted_state, scripted_updated_at')
    .eq('id', conversationId)
    .maybeSingle();

  if (error) {
    console.error('[scripted/state] loadScriptedState error:', error.message);
    return { step: null, state: {}, expired: false };
  }

  const state = (data?.scripted_state && typeof data.scripted_state === 'object')
    ? data.scripted_state
    : {};
  const step = data?.scripted_step || null;
  const updatedAt = data?.scripted_updated_at ? new Date(data.scripted_updated_at).getTime() : 0;
  const expired = step != null && updatedAt > 0 && (Date.now() - updatedAt) > SCRIPTED_STATE_TTL_MS;

  if (expired) {
    return { step: null, state: {}, expired: true };
  }

  return { step, state, expired: false };
}

/**
 * Guarda el nuevo step + state completo (reemplaza el state, no hace merge —
 * los steps se encargan de pasar el state merged).
 */
async function saveScriptedState(conversationId, step, state) {
  if (!conversationId) return;
  const { error } = await supabase
    .from('whatsapp_conversations')
    .update({
      scripted_step: step,
      scripted_state: state || {},
      scripted_updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
  if (error) {
    console.error('[scripted/state] saveScriptedState error:', error.message);
  }
}

/**
 * Limpia el estado scripted (flujo terminó, cancelado, o reset explícito).
 */
async function clearScriptedState(conversationId) {
  if (!conversationId) return;
  const { error } = await supabase
    .from('whatsapp_conversations')
    .update({
      scripted_step: null,
      scripted_state: {},
      scripted_updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);
  if (error) {
    console.error('[scripted/state] clearScriptedState error:', error.message);
  }
}

module.exports = {
  SCRIPTED_STATE_TTL_MS,
  loadScriptedState,
  saveScriptedState,
  clearScriptedState,
};
