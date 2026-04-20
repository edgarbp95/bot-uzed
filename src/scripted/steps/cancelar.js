'use strict';

/**
 * src/scripted/steps/cancelar.js — Flujo scripted de cancelar cita.
 *
 * Sub-steps:
 *   cancelar.elegir_cita    → list de citas futuras
 *   cancelar.confirmacion   → buttons [Sí, cancelar] [No]
 *
 * Prefijos de IDs:
 *   can.cita.<uuid>, can.conf.yes / can.conf.no
 */

const { handlers } = require('../../tools');
const { buildText, buildButtons, buildList } = require('../messages');
const {
  resolveScriptedPatientId,
  listPatientFutureAppointments,
  formatShortDateTimeEs,
} = require('../lib');

async function handleElegirCita(ctx, input, state) {
  if (!input) {
    const patientId = await resolveScriptedPatientId(ctx);
    if (!patientId) {
      return {
        messages: [
          buildText('No tengo citas registradas a tu nombre. Si tenías una, contactá a recepción.'),
        ],
        transition: 'end',
      };
    }

    const appts = await listPatientFutureAppointments(ctx, patientId);
    if (appts.length === 0) {
      return {
        messages: [buildText('No tenés citas futuras por cancelar.')],
        transition: 'end',
      };
    }

    if (appts.length === 1) {
      const only = appts[0];
      return {
        messages: [],
        transition: {
          to: 'cancelar.confirmacion',
          state: {
            ...state,
            appointmentId: only.id,
            cuando: only.cuando,
            profesional: only.profesional,
            tipo: only.tipo,
          },
        },
      };
    }

    return {
      messages: [
        buildList(
          '¿Cuál querés cancelar?',
          'Ver citas',
          [{
            title: 'Mis próximas citas',
            rows: appts.slice(0, 10).map((a) => ({
              id: `can.cita.${a.id}`,
              title: a.cuando,
              description: `${a.tipo || ''}${a.profesional ? ` · ${a.profesional}` : ''}`.trim(),
            })),
          }],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'list' && input.id?.startsWith('can.cita.')) {
    const id = input.id.slice('can.cita.'.length);
    const patientId = await resolveScriptedPatientId(ctx);
    const appts = await listPatientFutureAppointments(ctx, patientId);
    const only = appts.find((a) => a.id === id);
    if (!only) return await handleElegirCita(ctx, null, state);
    return {
      messages: [],
      transition: {
        to: 'cancelar.confirmacion',
        state: {
          ...state,
          appointmentId: only.id,
          cuando: only.cuando,
          profesional: only.profesional,
          tipo: only.tipo,
        },
      },
    };
  }

  return await handleElegirCita(ctx, null, state);
}

async function handleConfirmacion(ctx, input, state) {
  if (!input) {
    const detalle =
      `¿Cancelar ${state.tipo || 'la cita'} del ${state.cuando}` +
      (state.profesional ? ` con ${state.profesional}` : '') +
      `?`;
    return {
      messages: [
        buildButtons(
          detalle,
          [
            { id: 'can.conf.yes', title: 'Sí, cancelar' },
            { id: 'can.conf.no', title: 'No' },
          ],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'button' && input.id === 'can.conf.yes') {
    const r = await handlers.cancelar_cita(ctx, {
      appointment_id: state.appointmentId,
      motivo: 'Cancelada por el paciente vía WhatsApp (bot scripted)',
    });
    if (r?.error) {
      const msg = r.error === 'ya_estaba_cancelada'
        ? 'Esa cita ya estaba cancelada.'
        : r.error === 'no_autorizado'
        ? 'No pude verificar que la cita sea tuya.'
        : 'No pude cancelar la cita. Te paso con recepción.';
      return {
        messages: [buildText(msg)],
        transition: r.error === 'no_autorizado' ? { to: 'escalar.confirmacion', state } : 'end',
      };
    }
    return {
      messages: [buildText(`Listo, cancelé la cita del ${state.cuando}.`)],
      transition: 'end',
    };
  }

  if (input.type === 'button' && input.id === 'can.conf.no') {
    return {
      messages: [buildText('Perfecto, no cancelo nada. Tu cita sigue en pie.')],
      transition: 'end',
    };
  }

  return await handleConfirmacion(ctx, null, state);
}

module.exports = {
  handlers: {
    'cancelar.elegir_cita': handleElegirCita,
    'cancelar.confirmacion': handleConfirmacion,
  },
};
