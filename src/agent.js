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
const HISTORY_LIMIT = 30;
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

REGLAS:
1. SIEMPRE en español. Tono amable, claro, profesional. Sin emojis salvo que el paciente los use primero.
2. Mensajes BREVES (es WhatsApp). Sin párrafos largos. Sin formato markdown técnico.
3. Al iniciar, llama buscar_paciente UNA vez. Si no está, pídele los datos para registrarlo: nombre, apellido, y al menos UNO de (teléfono internacional o email).
4. El teléfono puede ser de cualquier país (Colombia +57, Venezuela +58, Argentina +54, etc.). Acepta el formato que mande, el sistema lo normaliza.
5. ANTES de buscar horarios, llama listar_tipos_cita y pregunta al paciente qué tipo necesita. La duración cambia los slots.
6. Muestra horarios en lenguaje natural (ej: "lunes 20 de abril a las 10:30 am"). NUNCA en ISO técnico. Cuando el paciente elija uno, usa el campo start_at del slot.
7. Antes de agendar_cita, repite al paciente: profesional + tipo + fecha/hora, y pide confirmación explícita ("sí", "confirmo").
8. NO inventes profesionales, especialidades, horarios ni citas. Usa SOLO lo que devuelven las tools.
9. NO des consejos médicos, diagnósticos, ni info sobre síntomas/medicamentos. Si preguntan algo médico, declina y ofrece agendar.
10. Para EMERGENCIAS, dile al paciente que llame al número de emergencias local (123 en Colombia) y NO atiendas el caso por chat.
11. Si pide hablar con una persona, o hay queja/factura/duda médica compleja → llama escalar_a_humano y deja de responder.
12. Si el paciente pregunta "¿qué puedes hacer?", resume tus funciones en 3-4 líneas.
13. NO muestres UUIDs ni IDs internos al paciente.`;
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
  try {
    // 1) Lookup canal → org
    const channel = await lookupChannelByPhoneNumberId(phoneNumberId);
    if (!channel) {
      console.warn(`[bot] phone_number_id ${phoneNumberId} sin canal activo. Ignorando mensaje.`);
      return;
    }

    // 2) Marcar como leído (best-effort, no bloquea)
    markAsRead({ phoneNumberId, accessToken, messageId }).catch(() => {});

    // 3) Org context (tz, service_line)
    const orgInfo = await loadOrgContext(channel.organization_id);

    // 4) Upsert conversación
    const conversationId = await upsertConversation({
      channelId: channel.id,
      organizationId: channel.organization_id,
      branchId: channel.branch_id,
      whatsapp: from,
      profileName,
    });

    const conv = await getConversation(conversationId);

    // 5) Guardar inbound siempre
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

    const system = buildSystemPrompt({
      org: orgInfo,
      channel,
      ctx,
      profileName,
    });

    // 8) Cargar historial desde DB (incluye el inbound recién guardado)
    const history = await loadHistory(conversationId);

    // 9) Run agent
    let reply;
    if (getProvider() === 'anthropic') {
      reply = await runAgentAnthropic(history, system, ctx);
    } else {
      reply = await runAgentGemini(history, system, ctx);
    }

    // 10) Si la conversación fue escalada por una tool, no enviar reply final
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
  } catch (error) {
    console.error('[bot] handleIncomingMessage error:', error);
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

async function runAgentAnthropic(history, system, ctx) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const response = await anthropicClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      tools,
      messages,
    });

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
      console.log(`[anthropic] org=${ctx.organizationId} wa=${ctx.whatsapp} -> ${toolUse.name}`, toolUse.input);
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
