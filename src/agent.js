'use strict';

/**
 * Agent multi-tenant para WhatsApp.
 *
 * Por cada mensaje entrante:
 *   1. Lookup del canal por phone_number_id → org/branch
 *   2. Upsert de la conversación (RPC wa_upsert_conversation)
 *   3. Si la conversación está en handoff humano, no responder (solo guardar inbound)
 *   4. Cargar org_settings (timezone, service_line) y display_name del canal
 *   5. Construir system prompt dinámico según service_line
 *   6. Cargar últimos N mensajes desde whatsapp_messages
 *   7. Ejecutar agent loop (Anthropic o Gemini) con tools (ctx scoped a la org)
 *   8. Guardar inbound y outbound en whatsapp_messages, actualizar last_message_*
 *
 * Soporta dos proveedores de LLM:
 *   - "google"    -> Gemini 2.0 Flash (GRATIS)
 *   - "anthropic" -> Claude Sonnet 4.5 (de pago, pero sigue instrucciones
 *                    mucho mejor que Haiku: menos alucinaciones,
 *                    menos loops de auto-corrección = ~igual costo neto).
 * Se elige con LLM_PROVIDER (default: google).
 */

const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { DateTime } = require('luxon');

const { sendMessage, markAsRead } = require('./whatsapp');
const { tools, geminiTools, executeTool } = require('./tools');
const { supabase } = require('./supabase');

const MAX_AGENT_TURNS = 6;
const HISTORY_LIMIT = 15;
const DEFAULT_TZ = 'America/Bogota';

function getProvider() {
  return (process.env.LLM_PROVIDER || 'google').toLowerCase();
}

// ============================================================
// Lookup multi-tenant
// ============================================================

async function lookupChannelByPhoneNumberId(phoneNumberId) {
  const { data, error } = await supabase
    .from('organization_whatsapp_channels')
    .select('id, organization_id, branch_id, display_name, display_phone_number, provisioning_mode, is_active')
    .eq('phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function loadOrgContext(organizationId) {
  // organizations: name, service_line, country
  const { data: org } = await supabase
    .from('organizations')
    .select('id, name, service_line, country')
    .eq('id', organizationId)
    .maybeSingle();

  // org_settings: timezone (FK org_id → organizations)
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

// ============================================================
// Conversación: upsert + history desde DB
// ============================================================

async function upsertConversation({ channelId, organizationId, branchId, whatsapp, profileName }) {
  const { data, error } = await supabase.rpc('wa_upsert_conversation', {
    p_channel_id: channelId,
    p_organization_id: organizationId,
    p_branch_id: branchId,
    p_whatsapp: whatsapp,
    p_profile_name: profileName || null,
  });
  if (error) throw error;
  return data; // uuid
}

async function getConversation(conversationId) {
  const { data } = await supabase
    .from('whatsapp_conversations')
    .select('id, status, patient_id, unread_count')
    .eq('id', conversationId)
    .maybeSingle();
  return data;
}

async function loadHistory(conversationId) {
  const { data } = await supabase
    .from('whatsapp_messages')
    .select('author, direction, content, content_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  // De más viejo a más nuevo
  const rows = (data || []).slice().reverse();
  // Solo texto va al modelo (multimedia futuro)
  return rows
    .filter((r) => r.content_type === 'text' && r.content)
    .map((r) => ({
      role: r.author === 'patient' ? 'user' : 'assistant',
      content: r.content,
    }));
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

  // Actualizar preview y last_message_at.
  // unread_count: cuando es inbound lo incrementamos (leer+sumar).
  // Cuando es outbound del bot, no tocamos unread — el inbox del staff
  // decide cuándo poner en 0 al abrir la conversación.
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
// System prompt dinámico
// ============================================================

function buildSystemPrompt({ org, channel, ctx, profileName }) {
  const today = DateTime.now()
    .setZone(ctx.timezone)
    .setLocale('es')
    .toFormat("cccc d 'de' LLLL 'de' yyyy, HH:mm");

  const lineLabels = {
    medical: { profesional: 'médico/a', clinica: 'clínica médica', servicio: 'consulta médica' },
    dental: { profesional: 'odontólogo/a', clinica: 'clínica dental', servicio: 'consulta odontológica' },
    veterinary: { profesional: 'veterinario/a', clinica: 'clínica veterinaria', servicio: 'consulta veterinaria' },
  };
  const lbl = lineLabels[org.serviceLine] || lineLabels.medical;

  const vetExtra =
    org.serviceLine === 'veterinary'
      ? `
- Esta es una clínica VETERINARIA. El "paciente" es la mascota; los datos de contacto son del dueño.
- Al registrar, usa patient_kind="animal" y completa species (perro/gato/etc), breed (opcional), owner_first_name, owner_last_name.
- first_name = nombre de la mascota; last_name = apellido del dueño.`
      : '';

  return `Eres el asistente virtual de WhatsApp de "${org.name}" (${lbl.clinica}). Atiendes a los pacientes 24/7 para:
- Informar sobre especialidades, profesionales y tipos de ${lbl.servicio}
- Mostrar disponibilidad de un ${lbl.profesional} y agendar citas
- Consultar, confirmar y cancelar citas existentes

CONTEXTO
- Fecha y hora actual (${ctx.timezone}): ${today}
- Canal: ${channel.display_name || channel.display_phone_number}
- País de la clínica: ${org.country || 'CO'}
- WhatsApp del paciente: +${ctx.whatsapp}${profileName ? ` (${profileName})` : ''}
${vetExtra}

REGIONALIZACIÓN (muy importante)
Habla el español profesional propio del país de la clínica. NO mezcles dialectos dentro de una misma conversación.
- CO (Colombia): tuteo neutro cálido. Usa "cuéntame, pásame, dime, con gusto, claro que sí, perfecto, ¿en qué te puedo ayudar?". Prohibido "vos, tenés, contame, dale, ¿querés?".
- AR / UY: voseo rioplatense. Usa "contame, pasame, dale, ¿en qué te puedo ayudar?, ¿querés?".
- MX (México): tuteo. Usa "platícame, mándame, claro que sí, con gusto, ¿en qué te puedo ayudar?".
- ES (España): tuteo. Usa "cuéntame, dime, vale, de acuerdo, ¿en qué te puedo ayudar?".
- Otros países LATAM: tuteo neutro latinoamericano (como CO pero sin regionalismos colombianos).

Además: espeja el registro del paciente. Si te trata de "usted", responde de usted consistentemente. Si te tutea, tutea. Si el país es AR/UY y usa voseo, voseálo. Mantén el mismo registro de principio a fin.

SALUDO
Cuando el paciente escribe por primera vez o solo saluda (hola, buenas, buen día), responde cálido y profesional y pregunta en qué puedes ayudar. Ajusta al país. Ejemplo CO: "¡Hola! Gracias por comunicarte con ${org.name}. Soy tu asistente virtual, ¿en qué te puedo ayudar?". No llames ninguna tool en el saludo inicial; espera a que diga qué necesita.

ESTILO CONVERSACIONAL (crítico — no suenes a bot de sí/no)
- Tono de recepcionista cálida y profesional. Frases completas, nunca respuestas telegráficas tipo "¿Nombre?" o "¿Sí o no?".
- Evita preguntas de sí/no cuando puedas hacer una pregunta abierta que recoja la información en un solo paso.
- Agrupa datos relacionados en una sola pregunta. Ejemplo: pide "nombre completo, fecha de nacimiento y correo" en una sola frase, no de a uno.
- Nunca repitas una pregunta si el dato ya está en la conversación. Si el paciente te da información extra sin que la pidas (motivo de consulta, hora preferida, etc.), guárdala y úsala después sin volver a preguntar.
- Mensajes breves (2-4 líneas), pero completos y cordiales.

FORMATO
- Prohibido: emojis (salvo que el paciente los use primero, y ahí uno ocasional está bien), markdown (**negrita**, #headers, listas con *), IDs/UUIDs visibles.
- Horarios en lenguaje natural: "lunes 20 de abril a las 10:30 am". Nunca en ISO.
- Al mostrar opciones, numéralas (1, 2, 3) o sepáralas con guiones simples. No uses emojis como viñetas.

FLUJO DE AGENDAMIENTO (sigue el orden, no saltes pasos)
1. Si el paciente pregunta por especialidades o profesionales → listar_especialidades o listar_profesionales según aplique.
2. Cuando elige un profesional → llama horarios_semanales_profesional y cuéntale qué días atiende.
   Ejemplo CO: "El Dr. Pérez atiende los lunes, martes y jueves. ¿Qué día te gustaría consultar disponibilidad?"
   NUNCA ofrezcas un día en el que no atiende. Si el paciente menciona un día que no está en la lista, avísale con amabilidad y ofrécele los que sí.
3. Cuando elige un día → llama listar_tipos_cita (si aún no la llamaste en esta conversación) y pregúntale qué tipo de consulta necesita.
4. Con día + tipo → llama consultar_horarios_disponibles(provider_id, fecha, appointment_type_id) y muestra los horarios del array slots_disponibles, tal como vienen. Si el array viene vacío, dile "no hay horarios disponibles ese día, ¿probamos otro?".
5. Cuando elige un horario específico, recién ahora identificamos al paciente (hasta aquí no le pediste datos personales).

   Antes que nada, tené claro PARA QUIÉN es la cita. Si el paciente no lo aclaró todavía, pregúntalo en la misma frase en que pedís los datos. Ejemplo: "¡Perfecto! Para reservarte ese horario, ¿la consulta es para ti o para otra persona?, y pásame el documento o el correo del paciente, por favor." Si ya lo dijo antes (p.ej. "es para mi hijo Tomás", "para mi esposa", "quiero agendar para mí"), NO lo vuelvas a preguntar.

   a) Con el documento y/o correo, llama buscar_paciente_por_identificador.
      - matches.length === 1: confirma SIEMPRE antes de usar ese patient_id, mostrando nombre y año de nacimiento. Ejemplo: "Perfecto, entonces sería la cita para María López (1987), ¿correcto?". Solo cuando diga que sí, usas ese id como patient_id.
      - matches.length > 1: pídele la fecha de nacimiento del paciente y vuelve a llamar buscar_paciente_por_identificador con birth_date. Si aún queda ambigüedad, llama escalar_a_humano.
      - matches.length === 0: el paciente no está registrado. Pide en una sola frase: nombre completo, fecha de nacimiento, y documento o correo del paciente (el teléfono es opcional). Luego llama registrar_paciente.
        • Si la cita NO es para quien escribe (familiar, pareja, hijo), pasa for_self=false. Si es para el propio contacto, for_self=true (o lo omites).
        • En clínicas veterinarias, patient_kind="animal" + owner_first_name/owner_last_name del dueño (el contacto).

   b) Repítele la cita en lenguaje natural (para quién, profesional, día/hora, tipo) y pide confirmación explícita.
   c) Cuando confirme, llama agendar_cita con el patient_id del paso a. No respondas texto antes.
   d) SOLO confirma que quedó agendada si agendar_cita devolvió un objeto con campo "id". Esa es la única prueba válida.

   NUNCA uses buscar_paciente (por WhatsApp) para identificar al paciente en el flujo de agendamiento: quien escribe puede no ser el paciente. NUNCA asumas identidad solo por coincidencia de nombre, aunque haya un único match — exige confirmación explícita.

CITAS EXISTENTES (paciente ya registrado con citas agendadas)
- Si pregunta por SUS propias citas ("¿cuándo es mi cita?" / "¿qué citas tengo?" / "confirmo mi cita" / "cancelar mi cita") y todavía no identificaste al paciente en esta conversación, primero llama buscar_paciente (por WhatsApp). Es un atajo razonable porque asumimos que el dueño del número habla de lo suyo.
- Si buscar_paciente devuelve null, o si el que escribe aclara que pregunta por otra persona (p.ej. "¿cuándo es la cita de mi hijo?"), usa buscar_paciente_por_identificador pidiendo documento o correo del paciente, con la misma lógica de confirmación del paso 5.
- "¿cuándo es mi cita?" / "¿qué citas tengo?" → consultar_citas_paciente y lista las próximas en lenguaje natural.
- "¿está confirmada mi cita?" → consultar_citas_paciente; si estado=scheduled di "está agendada pero aún no la has confirmado, ¿quieres confirmarla ahora?"; si estado=confirmed di que sí está confirmada.
- "confirmo mi cita" / "sí voy" → consultar_citas_paciente, luego confirmar_cita(appointment_id).
- "cancelar cita" → consultar_citas_paciente, confirma cuál cita y luego cancelar_cita.

REGLAS CRÍTICAS
- PROHIBIDO inventar UUIDs, nombres, horarios, días que atiende, tipos de cita o citas. Usa SOLO datos que devolvieron las tools en esta conversación.
- PROHIBIDO decir "agendada/confirmada/reservada" sin haber recibido el objeto de la tool correspondiente en este turno.
- PROHIBIDO pedirle datos personales al paciente antes de que haya elegido un horario concreto. Primero la información, después el registro.
- PROHIBIDO usar un patient_id sin que el usuario haya confirmado la identidad (nombre + año de nacimiento) cuando ese id vino de buscar_paciente_por_identificador. Un único match NO basta — siempre confirma.
- Si una tool devuelve error (provider_no_encontrado, tipo_cita_no_encontrado, out_of_schedule, double_booking, blocked_time, falta_identificador), NO confirmes al paciente. Llama a la tool que corrige el problema (listar_profesionales, listar_tipos_cita) o pide el dato que falta.

LÍMITES
- No das consejos médicos, diagnósticos ni información sobre síntomas o medicamentos. Si preguntan algo médico, declina amablemente y ofrece agendar.
- Emergencias → indica el número de emergencias del país (123 en CO, 911 en AR/MX/ES, etc.) y no atiendas el caso por chat.
- Si pide hablar con una persona, o hay queja/factura/duda compleja → llama escalar_a_humano y deja de responder.
- Si pregunta "¿qué puedes hacer?", resume en 3-4 líneas: consultar disponibilidad, agendar, confirmar y cancelar citas.`;
}

// ============================================================
// Handler público
// ============================================================

async function handleIncomingMessage({
  phoneNumberId,
  from,
  text,
  messageId,
  profileName,
  accessToken,
}) {
  // Estado diagnóstico — si el top-level catch dispara, lo usamos para
  // persistir el error en whatsapp_messages y en conversations.last_message_preview.
  let _channel = null;
  let _conversationId = null;
  let _step = 'init';
  try {
    // 1) Lookup canal → org
    _step = 'lookupChannel';
    const channel = await lookupChannelByPhoneNumberId(phoneNumberId);
    if (!channel) {
      console.warn(`[bot] phone_number_id ${phoneNumberId} sin canal activo. Ignorando mensaje.`);
      return;
    }
    _channel = channel;
    console.log(`[bot] step=lookupChannel ok org=${channel.organization_id} branch=${channel.branch_id}`);

    // 2) Marcar como leído (best-effort, no bloquea)
    markAsRead({ phoneNumberId, accessToken, messageId }).catch(() => {});

    // 3) Org context (tz, service_line)
    _step = 'loadOrgContext';
    const orgInfo = await loadOrgContext(channel.organization_id);
    console.log(`[bot] step=loadOrgContext ok line=${orgInfo.serviceLine} tz=${orgInfo.timezone}`);

    // 4) Upsert conversación
    _step = 'upsertConversation';
    const conversationId = await upsertConversation({
      channelId: channel.id,
      organizationId: channel.organization_id,
      branchId: channel.branch_id,
      whatsapp: from,
      profileName,
    });
    _conversationId = conversationId;
    console.log(`[bot] step=upsertConversation ok conv=${conversationId}`);

    _step = 'getConversation';
    const conv = await getConversation(conversationId);

    // 5) Guardar inbound siempre
    _step = 'saveMessage(inbound)';
    await saveMessage({
      organizationId: channel.organization_id,
      branchId: channel.branch_id,
      conversationId,
      channelId: channel.id,
      patientId: conv?.patient_id,
      direction: 'inbound',
      author: 'patient',
      content: text,
      wamid: messageId,
    });
    console.log(`[bot] step=saveMessage(inbound) ok`);

    // 6) Si está en handoff humano, no responder con bot
    if (conv?.status === 'human_handoff') {
      console.log(`[bot] conv ${conversationId} en handoff — no respondo.`);
      return;
    }

    // 7) Construir contexto para tools y prompt
    const ctx = {
      organizationId: channel.organization_id,
      branchId: channel.branch_id,
      serviceLine: orgInfo.serviceLine,
      timezone: orgInfo.timezone,
      whatsapp: from,
      conversationId,
    };

    _step = 'buildSystemPrompt';
    const system = buildSystemPrompt({
      org: orgInfo,
      channel,
      ctx,
      profileName,
    });
    console.log(`[bot] step=buildSystemPrompt ok len=${system.length}`);

    // 8) Cargar historial desde DB (incluye el inbound recién guardado)
    _step = 'loadHistory';
    const history = await loadHistory(conversationId);
    console.log(`[bot] step=loadHistory ok rows=${history.length}`);

    // 9) Run agent
    _step = `runAgent(${getProvider()})`;
    let reply;
    if (getProvider() === 'anthropic') {
      reply = await runAgentAnthropic(history, system, ctx);
    } else {
      reply = await runAgentGemini(history, system, ctx);
    }
    console.log(`[bot] step=runAgent ok replyLen=${(reply || '').length}`);

    // 10) Si la conversación fue escalada por una tool, no enviar reply final
    _step = 'sendOutbound';
    const convAfter = await getConversation(conversationId);
    if (convAfter?.status === 'human_handoff') {
      // Si el bot generó algún mensaje de despedida (ej. "le aviso al equipo"), enviarlo
      if (reply && reply.trim()) {
        await sendOutbound({ channel, ctx, conv: convAfter, accessToken, reply });
      }
      return;
    }

    if (reply && reply.trim()) {
      await sendOutbound({ channel, ctx, conv: convAfter, accessToken, reply });
    }
    console.log(`[bot] step=sendOutbound ok (flow complete)`);
  } catch (error) {
    const errMsg = `[${_step}] ${error?.message || String(error)}`;
    const errStack = error?.stack || '';
    console.error('[bot] handleIncomingMessage error:', _step, error);

    // Persistir error en DB para poder diagnosticar sin stderr.log
    if (_channel && _conversationId) {
      try {
        await supabase.from('whatsapp_messages').insert({
          organization_id: _channel.organization_id,
          branch_id: _channel.branch_id,
          conversation_id: _conversationId,
          channel_id: _channel.id,
          direction: 'outbound',
          author: 'system',
          content_type: 'text',
          content: '[ERROR INTERNO] ' + errMsg,
          error: (errMsg + '\n' + errStack).slice(0, 4000),
        });
        await supabase
          .from('whatsapp_conversations')
          .update({
            last_message_preview: `[ERROR] ${errMsg}`.slice(0, 200),
            last_message_at: new Date().toISOString(),
          })
          .eq('id', _conversationId);
      } catch (e) {
        console.error('[bot] no pude persistir el error en DB:', e?.message);
      }
    }

    try {
      await sendMessage({
        phoneNumberId,
        accessToken,
        to: from,
        text: 'Disculpa, tuve un problema procesando tu mensaje. ¿Podrías intentarlo de nuevo en un momento?',
      });
    } catch {}
  }
}

async function sendOutbound({ channel, ctx, conv, accessToken, reply }) {
  const sent = await sendMessage({
    phoneNumberId: (await channelPhoneNumberId(channel.id)) || undefined,
    accessToken,
    to: ctx.whatsapp,
    text: reply,
  });
  const wamid = sent?.messages?.[0]?.id;

  await saveMessage({
    organizationId: ctx.organizationId,
    branchId: ctx.branchId,
    conversationId: ctx.conversationId,
    channelId: channel.id,
    patientId: conv?.patient_id,
    direction: 'outbound',
    author: 'bot',
    content: reply,
    wamid,
  });
}

async function channelPhoneNumberId(channelId) {
  const { data } = await supabase
    .from('organization_whatsapp_channels')
    .select('phone_number_id')
    .eq('id', channelId)
    .maybeSingle();
  return data?.phone_number_id;
}

// ============================================================
// Anthropic (Claude Sonnet 4.5)
// ============================================================
let _anthropicClient = null;
function anthropicClient() {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropicClient;
}

/**
 * Prompt caching (Anthropic): marcamos el system prompt (estático) y la
 * última tool con cache_control=ephemeral. Todo lo que esté ANTES del
 * breakpoint se cachea. El caché dura 5 minutos y se renueva con cada uso;
 * así en un loop con varios tool calls la 2da/3ra/4ta llamada paga ~10%
 * del input.
 *
 * Si pasamos un `dynamicBlock` (ej: el estado de la conversación), va
 * DESPUÉS del breakpoint: se envía fresco cada turno, pero como son
 * ~100 tokens vs ~2500 del prompt base, el ahorro sigue siendo ~50-60%.
 *
 * Ahorro típico en nuestro agente: 40-60% de input tokens por mensaje.
 * Ref: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
function buildCachedSystem(system, dynamicBlock) {
  const blocks = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (dynamicBlock && dynamicBlock.trim()) {
    blocks.push({ type: 'text', text: dynamicBlock });
  }
  return blocks;
}

function buildCachedTools(toolList) {
  if (!toolList || toolList.length === 0) return toolList;
  return toolList.map((t, i) =>
    i === toolList.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' } }
      : t,
  );
}

// ============================================================
// Estado ligero de la conversación (optimización #4)
// ============================================================
// Persistimos en whatsapp_conversations las selecciones parciales del
// paciente (profesional, tipo, día, slot, paciente identificado). Luego
// las inyectamos como bloque NO-cacheado del system prompt, así el modelo
// no necesita re-derivarlas del historial y tampoco re-invoca tools para
// re-obtener los mismos IDs.
//
// Campos persistidos (ver migración):
//   bot_selected_provider_id, bot_selected_specialty_id,
//   bot_selected_appointment_type_id, bot_selected_date,
//   bot_selected_slot_start_at, bot_last_identified_patient_id,
//   bot_state_updated_at

const BOT_STATE_COLS = [
  'bot_selected_provider_id',
  'bot_selected_specialty_id',
  'bot_selected_appointment_type_id',
  'bot_selected_date',
  'bot_selected_slot_start_at',
  'bot_last_identified_patient_id',
  'bot_state_updated_at',
];

async function loadBotState(conversationId) {
  if (!conversationId) return {};
  const { data, error } = await supabase
    .from('whatsapp_conversations')
    .select(BOT_STATE_COLS.join(', '))
    .eq('id', conversationId)
    .maybeSingle();
  if (error) {
    console.error('[bot-state] load error:', error.message);
    return {};
  }
  return data || {};
}

/**
 * Formatea el estado como bloque compacto para el system prompt.
 * Devuelve null si no hay nada que mostrar.
 */
function formatBotState(state) {
  if (!state) return null;
  const lines = [];
  if (state.bot_selected_specialty_id)
    lines.push(`- specialty_id: ${state.bot_selected_specialty_id}`);
  if (state.bot_selected_provider_id)
    lines.push(`- provider_id: ${state.bot_selected_provider_id}`);
  if (state.bot_selected_appointment_type_id)
    lines.push(`- appointment_type_id: ${state.bot_selected_appointment_type_id}`);
  if (state.bot_selected_date)
    lines.push(`- fecha elegida: ${state.bot_selected_date}`);
  if (state.bot_selected_slot_start_at)
    lines.push(`- slot start_at: ${state.bot_selected_slot_start_at}`);
  if (state.bot_last_identified_patient_id)
    lines.push(`- patient_id (identificado y confirmado): ${state.bot_last_identified_patient_id}`);
  if (lines.length === 0) return null;
  return (
    'CONTEXTO DE LA CONVERSACIÓN (persistido por el backend — usá estos IDs tal cual, ' +
    'NO re-invoques listar_* solo para re-obtenerlos; sí re-invoca consultar_horarios_disponibles ' +
    'si el paciente cambia día o tipo):\n' +
    lines.join('\n')
  );
}

/**
 * Calcula el delta de estado a partir de (toolName, input, output) y lo
 * persiste en DB. Devuelve el estado resultante (merged) para que el loop
 * lo use en el próximo turno sin volver a leer la DB.
 *
 * Fire-and-forget para el UPDATE — si falla, se loguea pero el bot sigue.
 */
function applyBotStateDelta(ctx, state, toolName, input, output) {
  if (!ctx?.conversationId) return state;
  const delta = {};
  const inp = input || {};
  const out = output || {};

  // Selecciones implícitas via input de la tool.
  if (toolName === 'listar_profesionales' && inp.especialidad_id) {
    delta.bot_selected_specialty_id = inp.especialidad_id;
  }
  if (toolName === 'horarios_semanales_profesional' && inp.provider_id && out.atiende) {
    delta.bot_selected_provider_id = inp.provider_id;
  }
  if (toolName === 'consultar_horarios_disponibles') {
    if (inp.provider_id) delta.bot_selected_provider_id = inp.provider_id;
    if (inp.appointment_type_id) delta.bot_selected_appointment_type_id = inp.appointment_type_id;
    if (inp.fecha) delta.bot_selected_date = inp.fecha;
  }

  // Paciente identificado — de cualquiera de las 3 tools que lo establecen.
  if (toolName === 'buscar_paciente_por_identificador' && Array.isArray(out.matches) && out.matches.length === 1) {
    delta.bot_last_identified_patient_id = out.matches[0].id;
  }
  if (toolName === 'buscar_paciente' && out.paciente?.id) {
    delta.bot_last_identified_patient_id = out.paciente.id;
  }
  if (toolName === 'registrar_paciente' && out.paciente?.id) {
    delta.bot_last_identified_patient_id = out.paciente.id;
  }

  // Cita agendada: guardamos el slot y limpiamos los "selected" para que el
  // próximo agendamiento en la misma conversación empiece desde cero.
  if (toolName === 'agendar_cita' && out.cita?.id) {
    if (inp.start_at) delta.bot_selected_slot_start_at = inp.start_at;
    delta.bot_selected_provider_id = null;
    delta.bot_selected_specialty_id = null;
    delta.bot_selected_appointment_type_id = null;
    delta.bot_selected_date = null;
  }

  if (Object.keys(delta).length === 0) return state;
  delta.bot_state_updated_at = new Date().toISOString();

  // Persist (fire-and-forget).
  supabase
    .from('whatsapp_conversations')
    .update(delta)
    .eq('id', ctx.conversationId)
    .then(({ error }) => {
      if (error) console.error('[bot-state] update error:', error.message);
    })
    .catch((e) => console.error('[bot-state] unexpected:', e?.message));

  return { ...state, ...delta };
}

const FALLBACK_SILENT =
  'Disculpa, tuve un problema procesando tu mensaje. ¿Podrías repetírmelo con más detalle? Si preferís, puedo pasarte con una persona del equipo.';
const FALLBACK_MAX_TURNS =
  'Disculpa, no logré completar tu solicitud en esta conversación. ¿Puedes reformularla, o preferís que te pase con una persona del equipo?';

// ============================================================
// Costo estimado por modelo (USD por millón de tokens)
// ============================================================
// Mantener sincronizado con la tabla de precios pública de Anthropic.
// Solo se usa para la estimación que se guarda en whatsapp_llm_invocations;
// NO afecta el flujo del bot.
const MODEL_PRICING = {
  'claude-sonnet-4-5-20250929': {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.30,
  },
  // Fallback conservador si cambiamos de modelo sin actualizar esto.
  default: {
    input: 3.0,
    output: 15.0,
    cache_write: 3.75,
    cache_read: 0.30,
  },
};

function estimateCostUsd(model, usage) {
  const p = MODEL_PRICING[model] || MODEL_PRICING.default;
  const u = usage || {};
  const cost =
    ((u.input_tokens || 0) * p.input +
      (u.output_tokens || 0) * p.output +
      (u.cache_creation_input_tokens || 0) * p.cache_write +
      (u.cache_read_input_tokens || 0) * p.cache_read) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000; // 6 decimales
}

/**
 * Inserta una fila en whatsapp_llm_invocations. Fire-and-forget: si
 * falla, logueamos a stderr pero NO rompemos el turno del bot.
 */
function logLlmInvocation({ ctx, provider, model, turn, stopReason, usage, durationMs, error }) {
  if (!ctx?.organizationId) return;
  const row = {
    organization_id: ctx.organizationId,
    conversation_id: ctx.conversationId || null,
    provider,
    model,
    turn: typeof turn === 'number' ? turn : null,
    stop_reason: stopReason || null,
    input_tokens: usage?.input_tokens ?? null,
    output_tokens: usage?.output_tokens ?? null,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? null,
    estimated_cost_usd: estimateCostUsd(model, usage),
    duration_ms: typeof durationMs === 'number' ? Math.round(durationMs) : null,
    error: error || null,
  };
  supabase
    .from('whatsapp_llm_invocations')
    .insert(row)
    .then(({ error: insErr }) => {
      if (insErr) console.error('[llm-log] insert error:', insErr.message);
    })
    .catch((e) => console.error('[llm-log] unexpected:', e?.message));
}

async function runAgentAnthropic(history, system, ctx) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const cachedTools = buildCachedTools(tools);

  // Cargamos el estado de la conversación una sola vez y lo vamos mergeando
  // in-memory con cada delta. Evita round-trips extra a Supabase dentro del
  // loop del agente.
  let botState = await loadBotState(ctx.conversationId);

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const callStartedAt = Date.now();
    const MODEL_ID = 'claude-sonnet-4-5-20250929';
    // El system estático se cachea; el bloque de estado se envía fresco.
    const stateBlock = formatBotState(botState);
    const cachedSystem = buildCachedSystem(system, stateBlock);

    let response;
    try {
      response = await anthropicClient().messages.create({
        model: MODEL_ID,
        max_tokens: 1024,
        // 0.5 da respuestas algo más directas y menos "creativas" que el
        // default (~1.0), sin volverse robótico. El tono cálido lo marca
        // el system prompt; temperature solo reduce varianza.
        temperature: 0.5,
        system: cachedSystem,
        tools: cachedTools,
        messages,
      });
    } catch (err) {
      logLlmInvocation({
        ctx,
        provider: 'anthropic',
        model: MODEL_ID,
        turn,
        stopReason: 'error',
        usage: null,
        durationMs: Date.now() - callStartedAt,
        error: (err?.message || String(err)).slice(0, 4000),
      });
      throw err;
    }

    // Log de uso de caché — útil para ver si está pegando.
    const u = response.usage || {};
    if (u.cache_creation_input_tokens || u.cache_read_input_tokens) {
      console.error(
        `[anthropic usage] in=${u.input_tokens} out=${u.output_tokens} ` +
        `cache_write=${u.cache_creation_input_tokens || 0} ` +
        `cache_read=${u.cache_read_input_tokens || 0}`,
      );
    }

    // Persistir métricas del turno (fire-and-forget).
    logLlmInvocation({
      ctx,
      provider: 'anthropic',
      model: MODEL_ID,
      turn,
      stopReason: response.stop_reason,
      usage: u,
      durationMs: Date.now() - callStartedAt,
    });

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();

      // Defensa: si el modelo contestó vacío (lo que deja al paciente con
      // solo el visto), devolvemos un fallback. stop_reason también lo
      // informamos para diagnóstico.
      if (!text) {
        console.error(
          `[anthropic] respuesta vacía stop_reason=${response.stop_reason} turn=${turn}`,
        );
        return FALLBACK_SILENT;
      }
      return text;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      console.error(
        `[anthropic] org=${ctx.organizationId} wa=${ctx.whatsapp} -> ${toolUse.name} ` +
        JSON.stringify(toolUse.input),
      );
      const result = await executeTool(toolUse.name, toolUse.input, ctx);
      // Aplicar delta al estado de la conversación (persiste en DB fire-and-forget
      // y devuelve el merge para que el próximo turno vea la nueva selección).
      botState = applyBotStateDelta(ctx, botState, toolUse.name, toolUse.input, result);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return FALLBACK_MAX_TURNS;
}

// ============================================================
// Gemini 2.0 Flash
// ============================================================
let _geminiClient = null;
function geminiClient() {
  if (!_geminiClient) {
    _geminiClient = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  }
  return _geminiClient;
}

async function runAgentGemini(history, system, ctx) {
  const model = geminiClient().getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: system,
    tools: [{ functionDeclarations: geminiTools }],
  });

  // Gemini necesita historial sin el último mensaje del usuario (lo enviamos suelto)
  if (history.length === 0) return '';
  const lastUserMessage = history[history.length - 1];
  if (!lastUserMessage || lastUserMessage.role !== 'user') return '';

  const historyForGemini = history.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }));

  const chat = model.startChat({ history: historyForGemini });

  let result = await chat.sendMessage(
    typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage.content)
  );

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const response = result.response;
    const functionCalls = response.functionCalls();

    if (!functionCalls || functionCalls.length === 0) {
      return (response.text() || '').trim();
    }

    const functionResponses = [];
    for (const call of functionCalls) {
      console.log(`[gemini] org=${ctx.organizationId} wa=${ctx.whatsapp} -> ${call.name}`, call.args);
      const toolResult = await executeTool(call.name, call.args, ctx);
      functionResponses.push({
        functionResponse: { name: call.name, response: toolResult },
      });
    }

    result = await chat.sendMessage(functionResponses);
  }

  return 'Disculpa, no logré completar tu solicitud. ¿Puedes reformularla?';
}

module.exports = { handleIncomingMessage };
