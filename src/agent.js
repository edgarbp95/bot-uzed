'use strict';

/**
 * Agent module con soporte para DOS proveedores de LLM:
 *
 *   - "google"    -> Gemini 2.0 Flash (GRATIS, tier generoso)
 *   - "anthropic" -> Claude Haiku 4.5 (de pago, ~$0.004 por conversacion)
 *
 * Se elige con la variable de entorno LLM_PROVIDER.
 * Por defecto es "google" para no requerir pago inicial.
 *
 * Para migrar a Claude:
 *   1. Carga creditos en console.anthropic.com
 *   2. Pon ANTHROPIC_API_KEY en las env vars
 *   3. Cambia LLM_PROVIDER=anthropic
 *   4. Reinicia la app. Listo.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { sendMessage, markAsRead } = require('./whatsapp');
const { tools, geminiTools, executeTool } = require('./tools');
const { getHistory, addMessage } = require('./conversations');

const MAX_AGENT_TURNS = 6;

function getProvider() {
  return (process.env.LLM_PROVIDER || 'google').toLowerCase();
}

function buildSystemPrompt(whatsappNumber, profileName) {
  const today = new Date().toLocaleDateString('es-MX', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return `Eres el asistente virtual de Uzed Health, una plataforma de servicios medicos. Atiendes pacientes via WhatsApp para ayudarles con:
- Informacion sobre nuestros servicios y especialidades disponibles
- Consultar medicos por especialidad
- Consultar horarios disponibles
- Agendar, consultar y cancelar citas

CONTEXTO ACTUAL:
- Fecha y hora actual: ${today}
- Numero de WhatsApp del paciente: ${whatsappNumber}
${profileName ? `- Nombre del perfil de WhatsApp: ${profileName}` : ''}

REGLAS:
1. Responde SIEMPRE en espanol, con tono amable y profesional.
2. Los mensajes son por WhatsApp: se breve y claro. Evita parrafos largos.
3. Antes de agendar, verifica con buscar_paciente si el paciente ya esta registrado. Si no lo esta, pidele el nombre completo y registralo con registrar_paciente.
4. Al consultar horarios, muestralos en lenguaje natural (ej: "Lunes 20 de abril a las 10:30 AM"), NUNCA en formato ISO tecnico.
5. Al agendar, confirma SIEMPRE con el paciente antes de llamar a agendar_cita: repite medico, fecha y hora.
6. Cuando uses listar_medicos o listar_especialidades, guarda mentalmente los IDs que te devuelve la herramienta para usarlos despues. No los muestres al paciente.
7. NO des consejos medicos, diagnosticos, ni informacion sobre sintomas, medicamentos o tratamientos. Si el paciente pregunta algo medico, declina amablemente: "Para eso te recomiendo agendar una cita con uno de nuestros medicos." Y ofrece ayudarle a agendar.
8. Para emergencias medicas, indicale que llame inmediatamente al numero de emergencias local (911 en Mexico) y no intentes atender el caso.
9. Si el paciente pide algo fuera de tu alcance (facturacion, quejas, reembolsos), dile que lo escalaras a un humano del equipo.
10. NUNCA inventes medicos, horarios, especialidades o citas. Usa solo lo que te devuelven las herramientas.
11. Si el paciente pregunta que puedes hacer, resume brevemente tus funciones en 3-4 puntos.
12. Al cancelar o agendar, siempre confirma la accion con un mensaje claro al final.`;
}

// ============================================================
// Handler publico
// ============================================================
async function handleIncomingMessage({ from, text, messageId, profileName }) {
  try {
    markAsRead(messageId).catch(() => {});
    addMessage(from, { role: 'user', content: text });

    const system = buildSystemPrompt(from, profileName);
    const history = getHistory(from);

    let reply;
    if (getProvider() === 'anthropic') {
      reply = await runAgentAnthropic(history, system, from);
    } else {
      reply = await runAgentGemini(history, system, from);
    }

    if (reply && reply.trim()) {
      await sendMessage(from, reply);
      addMessage(from, { role: 'assistant', content: reply });
    }
  } catch (error) {
    console.error('handleIncomingMessage error:', error);
    try {
      await sendMessage(
        from,
        'Disculpa, tuve un problema procesando tu mensaje. ¿Podrias intentar de nuevo?'
      );
    } catch {}
  }
}

// ============================================================
// Implementacion Anthropic (Claude Haiku 4.5)
// ============================================================
let _anthropicClient = null;
function anthropicClient() {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropicClient;
}

async function runAgentAnthropic(history, system, whatsappNumber) {
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
      console.log(`[anthropic] ${whatsappNumber} -> ${toolUse.name}`, toolUse.input);
      const result = await executeTool(toolUse.name, toolUse.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  return 'Disculpa, no logre completar tu solicitud. ¿Puedes reformularla?';
}

// ============================================================
// Implementacion Google Gemini 2.0 Flash
// ============================================================
let _geminiClient = null;
function geminiClient() {
  if (!_geminiClient) {
    _geminiClient = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  }
  return _geminiClient;
}

async function runAgentGemini(history, system, whatsappNumber) {
  const model = geminiClient().getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: system,
    tools: [{ functionDeclarations: geminiTools }],
  });

  // Historial previo (todo menos el ultimo mensaje del usuario, que lo enviamos con sendMessage)
  const historyForGemini = history.slice(0, -1).map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }));

  const lastUserMessage = history[history.length - 1];
  if (!lastUserMessage || lastUserMessage.role !== 'user') {
    return '';
  }

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
      return response.text().trim();
    }

    const functionResponses = [];
    for (const call of functionCalls) {
      console.log(`[gemini] ${whatsappNumber} -> ${call.name}`, call.args);
      const toolResult = await executeTool(call.name, call.args);
      functionResponses.push({
        functionResponse: {
          name: call.name,
          response: toolResult,
        },
      });
    }

    result = await chat.sendMessage(functionResponses);
  }

  return 'Disculpa, no logre completar tu solicitud. ¿Puedes reformularla?';
}

module.exports = { handleIncomingMessage };