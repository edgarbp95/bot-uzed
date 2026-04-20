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
          'No tengo citas a tu nombre. Si querés agendar una, escribí "menú" y elegí "Agendar".',
        ),
      ],
      transition: 'end',
    };
  }

  const appts = await listPatientFutureAppointments(ctx, patientId);
  if (appts.length === 0) {
    return {
      messages: [buildText('No tenés citas futuras registradas.')],
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
        `Tus próximas citas:\n\n${lines.join('\n')}\n\n` +
        'Si querés reprogramar o cancelar alguna, escribí "menú".',
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
