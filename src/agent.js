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
 *   - "anthropic" -> Claude Haiku 4.5 (de pago)
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

  return `Eres el asistente virtual por WhatsApp de "${org.name}" (${lbl.clinica}). Atiendes a los pacientes 24/7 para ayudarles con:
- Información de especialidades, profesionales y tipos de ${lbl.servicio}
- Consultar horarios disponibles de un ${lbl.profesional}
- Agendar, consultar y cancelar citas

CONTEXTO:
- Fecha y hora actual (${ctx.timezone}): ${today}
- Canal: ${channel.display_name || channel.display_phone_number}
- Número de WhatsApp del paciente: +${ctx.whatsapp}${profileName ? `\n- Nombre de WhatsApp: ${profileName}` : ''}
${vetExtra}

REGLAS DE FORMATO (WhatsApp):
1. SIEMPRE en español. Tono amable, claro, profesional. Mensajes BREVES.
2. PROHIBIDO: emojis, markdown doble asterisco, headers con almohadilla, guiones con acento, IDs/UUIDs.
   - Incorrecto: "✅ Tu cita está agendada. **Lunes 20 de abril a las 11:00 a. m. con Edgar Buenaño**"
   - Correcto:   "Listo, tu cita quedó agendada para el lunes 20 de abril a las 11:00 am con Edgar Buenaño."
   - Incorrecto: "📅 Lunes 20\n👨‍⚕️ Dr. Buenaño\n📋 Consulta General"
   - Correcto:   "Lunes 20 a las 11:00 am con Edgar Buenaño — Consulta general."
3. Si el paciente usa emojis, podés responder con un emoji ocasional. Nunca los uses vos primero.

REGLAS DE FLUJO:
4. Al iniciar, llama buscar_paciente UNA vez. Si no está, pídele los datos para registrarlo: nombre, apellido, y al menos UNO de (teléfono internacional o email).
5. El teléfono puede ser de cualquier país. Acepta el formato que mande, el sistema lo normaliza.
6. ANTES de buscar horarios, llama listar_tipos_cita y pregunta al paciente qué tipo necesita.
7. Muestra horarios en lenguaje natural ("lunes 20 de abril a las 10:30 am"). NUNCA en ISO técnico. Cuando el paciente elija un horario, usa el campo start_at TAL CUAL venga del slot (no lo recalcules).

REGLAS DE AGENDAMIENTO (críticas, leer con atención):
8. Para agendar:
   a) Repite al paciente profesional + tipo + fecha/hora y pide confirmación explícita ("sí", "confirmo", "dale").
   b) Cuando el paciente confirma, llama agendar_cita EN EL MISMO TURNO. No respondas con texto primero.
   c) SOLO confirma al paciente que la cita quedó agendada si recibiste un objeto "cita" con campo "id" en la respuesta de agendar_cita. Esa es la única evidencia válida.
   d) Si agendar_cita devuelve un objeto con campo "error", NO confirmes. Explica al paciente qué pasó según el error:
      - "out_of_schedule" → "Ese horario no está en los turnos del profesional, ¿elegimos otro?"
      - "double_booking" → "Otro paciente acaba de tomar ese horario, ¿probamos otro?"
      - "blocked_time" → "El profesional tiene un bloqueo en ese horario, ¿elegimos otro?"
      - cualquier otro error → "No pude agendar por un problema técnico, ¿querés que te pase con una persona?" y ofrece escalar_a_humano.
   e) JAMÁS digas "agendada", "confirmada", "reservada" o frases equivalentes sin un objeto "cita" de agendar_cita recibido en este turno. Si no lo llamaste o falló, no inventes que quedó.

REGLAS GENERALES:
9. NO inventes profesionales, especialidades, horarios, tipos de cita, citas previas, ni datos del paciente. Usa SOLO lo que devuelven las tools.
10. NO des consejos médicos, diagnósticos, ni info sobre síntomas/medicamentos. Si preguntan algo médico, declina y ofrece agendar.
11. Para EMERGENCIAS, dile al paciente que llame al número de emergencias local (123 en Colombia) y NO atiendas el caso por chat.
12. Si pide hablar con una persona, o hay queja/factura/duda médica compleja → llama escalar_a_humano y deja de responder.
13. Si el paciente pregunta "¿qué puedes hacer?", resume tus funciones en 3-4 líneas.`;
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
// Anthropic (Claude Haiku 4.5)
// ============================================================
let _anthropicClient = null;
function anthropicClient() {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropicClient;
}

/**
 * Prompt caching (Anthropic): marcamos el system prompt y la última tool
 * con cache_control=ephemeral. Todo lo que esté ANTES del breakpoint se
 * cachea. El caché dura 5 minutos y se renueva con cada uso; así en un
 * loop con varios tool calls la 2da/3ra/4ta llamada paga ~10% del input.
 *
 * Ahorro típico en nuestro agente: 40-60% de input tokens por mensaje.
 * Ref: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */
function buildCachedSystem(system) {
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

function buildCachedTools(toolList) {
  if (!toolList || toolList.length === 0) return toolList;
  return toolList.map((t, i) =>
    i === toolList.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' } }
      : t,
  );
}

async function runAgentAnthropic(history, system, ctx) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const cachedSystem = buildCachedSystem(system);
  const cachedTools = buildCachedTools(tools);

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const response = await anthropicClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: cachedSystem,
      tools: cachedTools,
      messages,
    });

    // Log de uso de caché — útil para ver si está pegando.
    const u = response.usage || {};
    if (u.cache_creation_input_tokens || u.cache_read_input_tokens) {
      console.error(
        `[anthropic usage] in=${u.input_tokens} out=${u.output_tokens} ` +
        `cache_write=${u.cache_creation_input_tokens || 0} ` +
        `cache_read=${u.cache_read_input_tokens || 0}`,
      );
    }

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');

    if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      console.error(
        `[anthropic] org=${ctx.organizationId} wa=${ctx.whatsapp} -> ${toolUse.name} ` +
        JSON.stringify(toolUse.input),
      );
      const result = await executeTool(toolUse.name, toolUse.input, ctx);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return 'Disculpa, no logré completar tu solicitud. ¿Puedes reformularla?';
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
