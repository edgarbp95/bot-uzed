'use strict';

/**
 * src/scripted/steps/escalar.js — Escalar a recepción (handoff humano).
 *
 * Step único 'escalar.confirmacion':
 *   - On entry: pide confirmación con botones [Sí, avisar] [No]
 *   - On 'Sí': llama escalar_a_humano y termina.
 *   - On 'No': vuelve al menú.
 *
 * Nota: el handler escalar_a_humano setea la conversación en
 * 'human_handoff', y el router de entrada respeta ese estado en
 * futuros mensajes (no responde el bot, solo staff).
 */

const { handlers } = require('../../tools');
const { buildText, buildButtons } = require('../messages');

async function handleEscalar(ctx, input, state) {
  if (!input) {
    return {
      messages: [
        buildButtons(
          '¿Querés que alguien del equipo te atienda por acá? Les aviso y te escriben apenas puedan.',
          [
            { id: 'esc.yes', title: 'Sí, por favor' },
            { id: 'esc.no', title: 'No, gracias' },
          ],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'button' && input.id === 'esc.yes') {
    const r = await handlers.escalar_a_humano(ctx, {
      motivo: 'Paciente pidió hablar con recepción desde el bot scripted.',
    });
    const msg = r?.mensaje || 'Listo, ya le avisé al equipo. Te van a escribir por acá apenas estén disponibles. Gracias por tu paciencia.';
    return {
      messages: [buildText(msg)],
      transition: 'end',
    };
  }

  if (input.type === 'button' && input.id === 'esc.no') {
    return {
      messages: [],
      transition: { to: 'menu', state: {} },
    };
  }

  return await handleEscalar(ctx, null, state);
}

module.exports = {
  handlers: {
    'escalar.confirmacion': handleEscalar,
  },
};
