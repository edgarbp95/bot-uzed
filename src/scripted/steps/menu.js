'use strict';

/**
 * src/scripted/steps/menu.js — Menú principal del bot scripted.
 *
 * Es el step inicial cualquiera sea la conversación:
 *   - Primer mensaje del paciente (sin step previo) → arranca acá.
 *   - Al terminar cualquier flujo (agendar, cancelar, etc.) → queda libre;
 *     la próxima vez que escriba vuelve a entrar acá.
 *   - Si en un step el paciente escribe "menu", "volver" o similar, se
 *     lo enrutamos de nuevo acá (lo maneja el dispatcher).
 */

const { buildList } = require('../messages');

const MENU_ID = {
  AGENDAR: 'menu.agendar',
  REPROGRAMAR: 'menu.reprogramar',
  CANCELAR: 'menu.cancelar',
  VER_CITAS: 'menu.ver',
  RECEPCION: 'menu.recepcion',
};

function renderMenu(orgName) {
  const body =
    `¡Hola! Te saluda el asistente virtual de ${orgName || 'la clínica'}. ` +
    `Con mucho gusto te ayudo a agendar, reprogramar o cancelar tus citas. ` +
    `¿En qué puedo ayudarte hoy?`;
  return buildList(
    body,
    'Ver opciones',
    [
      {
        title: 'Agenda',
        rows: [
          { id: MENU_ID.AGENDAR, title: 'Agendar una cita', description: 'Reservar un nuevo turno' },
          { id: MENU_ID.REPROGRAMAR, title: 'Reprogramar', description: 'Cambiar día u hora' },
          { id: MENU_ID.CANCELAR, title: 'Cancelar', description: 'Anular una cita' },
          { id: MENU_ID.VER_CITAS, title: 'Mis citas', description: 'Ver mis próximos turnos' },
        ],
      },
      {
        title: 'Ayuda',
        rows: [
          { id: MENU_ID.RECEPCION, title: 'Hablar con recepción', description: 'Me comunico con una persona' },
        ],
      },
    ],
  );
}

/**
 * Handler del step 'menu'.
 *
 * @param {object} ctx - ctx del bot (orgName viene de ctx.orgName)
 * @param {object|null} input - null si recién entramos; si viene, el router
 *   ya lo normalizó: { type: 'text'|'list'|'button'|'flow', id?, text?, flowResponse? }
 * @param {object} state
 */
async function handle(ctx, input, state) {
  // Primera entrada o input de texto libre que no matchea → mostramos menú.
  if (!input || input.type === 'text') {
    return {
      messages: [renderMenu(ctx.orgName)],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'list') {
    switch (input.id) {
      case MENU_ID.AGENDAR:
        return { messages: [], transition: { to: 'agendar.especialidad', state: {} } };
      case MENU_ID.REPROGRAMAR:
        return { messages: [], transition: { to: 'reprogramar.elegir_cita', state: {} } };
      case MENU_ID.CANCELAR:
        return { messages: [], transition: { to: 'cancelar.elegir_cita', state: {} } };
      case MENU_ID.VER_CITAS:
        return { messages: [], transition: { to: 'ver_citas', state: {} } };
      case MENU_ID.RECEPCION:
        return { messages: [], transition: { to: 'escalar.confirmacion', state: {} } };
    }
  }

  // Cualquier otra cosa: re-mostramos el menú.
  return {
    messages: [renderMenu(ctx.orgName)],
    transition: 'stay',
    state,
  };
}

module.exports = {
  MENU_ID,
  renderMenu,
  handlers: {
    menu: handle,
  },
};
