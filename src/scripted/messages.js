'use strict';

/**
 * src/scripted/messages.js
 *
 * Builders para construir payloads interactive de WhatsApp Cloud API.
 * Cada función devuelve el objeto `interactive` (sin el wrapper `to`/`type`)
 * — el wrapper lo agrega `sendInteractive` en src/whatsapp.js.
 *
 * Referencia oficial:
 * https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates/interactive-messages
 *
 * Límites duros de WhatsApp que los builders respetan / truncan:
 *   - body.text: 1024 chars
 *   - footer.text: 60 chars
 *   - reply buttons: máx 3, title 20 chars, id 256 chars
 *   - list sections: máx 10 filas totales (sumando todas las secciones),
 *     máx 10 secciones, row.title 24 chars, row.description 72 chars,
 *     button label 20 chars
 *   - flow cta: 20 chars
 */

// ============================================================
// Utilidades de truncado — mejor truncar con "…" que fallar 400
// ============================================================

function truncate(s, max) {
  if (s == null) return '';
  const str = String(s);
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + '…';
}

const LIMITS = {
  body: 1024,
  header: 60,
  footer: 60,
  buttonTitle: 20,
  listButton: 20,
  rowTitle: 24,
  rowDescription: 72,
  id: 256,
  flowCta: 20,
};

// ============================================================
// Text message
// ============================================================

/**
 * Mensaje de texto simple. Lo devolvemos con la misma interfaz que los
 * interactive builders (devuelve `{ type: 'text', body: {...} }`) para
 * que el router pueda tratarlos uniforme. El emisor decide si usar
 * sendMessage() o sendInteractive() en base a .type.
 *
 * Uso típico desde steps: `{ kind: 'text', text: '...' }` — pero acá el
 * builder devuelve la forma ya lista para serializar.
 */
function buildText(text) {
  return { kind: 'text', text: truncate(text, 4096) }; // WA hard limit de texto es 4096
}

// ============================================================
// Reply buttons — hasta 3 botones
// ============================================================

/**
 * @param {string} bodyText - Texto principal (pregunta).
 * @param {Array<{id: string, title: string}>} buttons - Máx 3.
 * @param {object} [opts]
 * @param {string} [opts.header] - Encabezado corto opcional.
 * @param {string} [opts.footer] - Pie corto opcional.
 */
function buildButtons(bodyText, buttons, opts = {}) {
  const btns = (buttons || []).slice(0, 3).map((b) => ({
    type: 'reply',
    reply: {
      id: truncate(b.id, LIMITS.id),
      title: truncate(b.title, LIMITS.buttonTitle),
    },
  }));

  const interactive = {
    type: 'button',
    body: { text: truncate(bodyText, LIMITS.body) },
    action: { buttons: btns },
  };
  if (opts.header) {
    interactive.header = { type: 'text', text: truncate(opts.header, LIMITS.header) };
  }
  if (opts.footer) {
    interactive.footer = { text: truncate(opts.footer, LIMITS.footer) };
  }

  return { kind: 'interactive', interactive };
}

// ============================================================
// List message — hasta 10 filas totales
// ============================================================

/**
 * @param {string} bodyText - Texto principal.
 * @param {string} buttonLabel - Label del botón que abre la lista (ej. "Ver opciones").
 * @param {Array<{title: string, rows: Array<{id: string, title: string, description?: string}>}>} sections
 * @param {object} [opts]
 * @param {string} [opts.header]
 * @param {string} [opts.footer]
 */
function buildList(bodyText, buttonLabel, sections, opts = {}) {
  // Deduplicar y truncar filas globalmente a 10
  const normalized = [];
  let total = 0;
  for (const sec of sections || []) {
    if (total >= 10) break;
    const rows = [];
    for (const row of sec.rows || []) {
      if (total >= 10) break;
      rows.push({
        id: truncate(row.id, LIMITS.id),
        title: truncate(row.title, LIMITS.rowTitle),
        ...(row.description
          ? { description: truncate(row.description, LIMITS.rowDescription) }
          : {}),
      });
      total++;
    }
    if (rows.length > 0) {
      normalized.push({ title: truncate(sec.title, 24), rows });
    }
  }

  const interactive = {
    type: 'list',
    body: { text: truncate(bodyText, LIMITS.body) },
    action: {
      button: truncate(buttonLabel, LIMITS.listButton),
      sections: normalized,
    },
  };
  if (opts.header) {
    interactive.header = { type: 'text', text: truncate(opts.header, LIMITS.header) };
  }
  if (opts.footer) {
    interactive.footer = { text: truncate(opts.footer, LIMITS.footer) };
  }

  return { kind: 'interactive', interactive };
}

// ============================================================
// Flow (estático) — abre un Flow publicado en WhatsApp Manager
// ============================================================

/**
 * Solo se usa cuando WHATSAPP_USE_FLOW_REGISTRO=true y
 * WHATSAPP_FLOW_REGISTRO_ID está seteado. Si alguno falta, el step debería
 * elegir la vía secuencial en vez de llamar a esto.
 *
 * @param {string} bodyText
 * @param {object} params
 * @param {string} params.flowId - ID del Flow publicado en Meta.
 * @param {string} params.flowToken - Token propio para rastrear la sesión (ej. conversationId).
 * @param {string} params.cta - Label del botón que abre el Flow (máx 20 chars).
 * @param {string} params.initialScreen - ID de la pantalla inicial del Flow.
 * @param {object} [params.initialData] - Datos precargados en la pantalla inicial.
 */
function buildFlow(bodyText, { flowId, flowToken, cta, initialScreen, initialData }) {
  const payload = { screen: initialScreen };
  if (initialData && typeof initialData === 'object') {
    payload.data = initialData;
  }

  const interactive = {
    type: 'flow',
    body: { text: truncate(bodyText, LIMITS.body) },
    action: {
      name: 'flow',
      parameters: {
        flow_message_version: '3',
        flow_token: String(flowToken),
        flow_id: String(flowId),
        flow_cta: truncate(cta, LIMITS.flowCta),
        flow_action: 'navigate',
        flow_action_payload: payload,
      },
    },
  };

  return { kind: 'interactive', interactive };
}

module.exports = {
  buildText,
  buildButtons,
  buildList,
  buildFlow,
  // expuesto por si un step necesita truncar algo custom
  _truncate: truncate,
  _LIMITS: LIMITS,
};
