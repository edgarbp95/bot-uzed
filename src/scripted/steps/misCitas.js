'use strict';

/**
 * src/scripted/steps/misCitas.js — Mostrar citas futuras del paciente.
 *
 * Step único 'ver_citas'. No espera input — lista y termina.
 */

const { buildText } = require('../messages');
const {
  resolveScriptedPatientId,
  listPatientFutureAppointments,
} = require('../lib');

async function handleVerCitas(ctx, _input, state) {
  const patientId = await resolveScriptedPatientId(ctx);
  if (!patientId) {
    return {
      messages: [
        buildText(
          'No veo citas registradas a tu nombre. Si quieres agendar una, escribe "menú" y elige "Agendar" — te ayudo con todo el proceso.',
        ),
      ],
      transition: 'end',
    };
  }

  const appts = await listPatientFutureAppointments(ctx, patientId);
  if (appts.length === 0) {
    return {
      messages: [buildText('Por ahora no tienes citas futuras registradas.')],
      transition: 'end',
    };
  }

  // Render prolijo en texto — cada cita en su línea.
  const lines = appts.map((a, i) => {
    const base = `${i + 1}. ${a.cuando}`;
    const extras = [a.tipo, a.profesional].filter(Boolean).join(' · ');
    return extras ? `${base} — ${extras}` : base;
  });

  return {
    messages: [
      buildText(
        `Estas son tus próximas citas:\n\n${lines.join('\n')}\n\n` +
        'Si necesitas reprogramar o cancelar alguna, escribe "menú" y te ayudo.',
      ),
    ],
    transition: 'end',
  };
}

module.exports = {
  handlers: {
    ver_citas: handleVerCitas,
  },
};
