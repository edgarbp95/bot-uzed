'use strict';

/**
 * src/scripted/steps/reprogramar.js — Flujo scripted de reprogramar cita.
 *
 * Sub-steps:
 *   reprogramar.elegir_cita   → list de citas futuras (filtrando las que
 *                               caen dentro de las próximas 2h, que por
 *                               regla de negocio no se reprograman)
 *   reprogramar.dia           → list de próx días con slots (excluyendo
 *                               la propia cita del chequeo)
 *   reprogramar.hora          → list de slots
 *   reprogramar.confirmacion  → buttons [Confirmar] [Cancelar]
 *
 * Prefijos de IDs:
 *   rep.cita.<uuid>, rep.dia.<yyyy-MM-dd>, rep.hora.<iso>,
 *   rep.conf.yes / rep.conf.no
 */

const { handlers } = require('../../tools');
const { buildText, buildButtons, buildList } = require('../messages');
const {
  resolveScriptedPatientId,
  listPatientFutureAppointments,
  findAvailableDaysForProvider,
  formatTimeLabelEs,
  formatShortDateTimeEs,
} = require('../lib');

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

// ============================================================
// 1) Elegir cita a reprogramar
// ============================================================

async function handleElegirCita(ctx, input, state) {
  if (!input) {
    const patientId = await resolveScriptedPatientId(ctx);
    if (!patientId) {
      return {
        messages: [
          buildText(
            'No tengo registrada ninguna cita a tu nombre. ' +
            'Si querés, agendemos una — escribí "menú" y elegí "Agendar".',
          ),
        ],
        transition: 'end',
      };
    }

    const appts = await listPatientFutureAppointments(ctx, patientId);
    // Filtrar las que ya están dentro de la ventana de 2h — no se pueden
    // reprogramar, así que no las mostramos como opción.
    const reprogramables = appts.filter((a) => {
      const diffMs = new Date(a.start_at).getTime() - Date.now();
      return diffMs >= TWO_HOURS_MS;
    });

    if (reprogramables.length === 0) {
      if (appts.length > 0) {
        return {
          messages: [
            buildText(
              'Tus próximas citas son demasiado cercanas como para ' +
              'reprogramarlas por acá (la regla es al menos 2 horas antes). ' +
              'Te paso con recepción.',
            ),
          ],
          transition: { to: 'escalar.confirmacion', state },
        };
      }
      return {
        messages: [
          buildText(
            'No tengo citas futuras a tu nombre. Si querés agendar, ' +
            'escribí "menú" y elegí "Agendar una cita".',
          ),
        ],
        transition: 'end',
      };
    }

    if (reprogramables.length === 1) {
      const only = reprogramables[0];
      return {
        messages: [],
        transition: {
          to: 'reprogramar.dia',
          state: {
            ...state,
            appointmentId: only.id,
            oldStartAt: only.start_at,
            oldCuando: only.cuando,
            providerName: only.profesional,
            appointmentTypeName: only.tipo,
          },
        },
      };
    }

    return {
      messages: [
        buildList(
          '¿Cuál querés reprogramar?',
          'Ver citas',
          [{
            title: 'Mis próximas citas',
            rows: reprogramables.slice(0, 10).map((a) => ({
              id: `rep.cita.${a.id}`,
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

  if (input.type === 'list' && input.id?.startsWith('rep.cita.')) {
    const id = input.id.slice('rep.cita.'.length);
    const patientId = await resolveScriptedPatientId(ctx);
    const appts = await listPatientFutureAppointments(ctx, patientId);
    const only = appts.find((a) => a.id === id);
    if (!only) return await handleElegirCita(ctx, null, state);
    return {
      messages: [],
      transition: {
        to: 'reprogramar.dia',
        state: {
          ...state,
          appointmentId: only.id,
          oldStartAt: only.start_at,
          oldCuando: only.cuando,
          providerName: only.profesional,
          appointmentTypeName: only.tipo,
        },
      },
    };
  }

  return await handleElegirCita(ctx, null, state);
}

// ============================================================
// 2) Elegir día (para la cita seleccionada)
// ============================================================

async function handleDia(ctx, input, state) {
  if (!input) {
    // Necesitamos provider_id y appointment_type_id de la cita. Los
    // obtenemos leyendo la cita (no los tenemos guardados en state
    // por defecto — los traemos ahora).
    const r = await fetchAppointmentBasics(ctx, state.appointmentId);
    if (!r) {
      return {
        messages: [buildText('No encontré la cita que querías reprogramar. Volvé al menú y reintentá.')],
        transition: 'end',
      };
    }

    const days = await findAvailableDaysForProvider(ctx, {
      provider_id: r.provider_id,
      appointment_type_id: r.appointment_type_id,
      exclude_appointment_id: state.appointmentId,
    });

    if (days.length === 0) {
      return {
        messages: [
          buildText(
            'No veo disponibilidad en los próximos 30 días con ese profesional. Te paso con recepción.',
          ),
        ],
        transition: { to: 'escalar.confirmacion', state },
      };
    }

    return {
      messages: [
        buildText(`Reprogramando tu cita del ${state.oldCuando || 'original'}.`),
        buildList(
          '¿Para qué día la movemos?',
          'Ver días',
          [{
            title: 'Próximos días',
            rows: days.map((d) => ({
              id: `rep.dia.${d.date}`,
              title: d.label,
              description: `${d.slots_count} horario${d.slots_count === 1 ? '' : 's'}`,
            })),
          }],
        ),
      ],
      transition: 'stay',
      state: {
        ...state,
        providerId: r.provider_id,
        appointmentTypeId: r.appointment_type_id,
      },
    };
  }

  if (input.type === 'list' && input.id?.startsWith('rep.dia.')) {
    const date = input.id.slice('rep.dia.'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return await handleDia(ctx, null, state);
    return {
      messages: [],
      transition: {
        to: 'reprogramar.hora',
        state: { ...state, date },
      },
    };
  }

  return await handleDia(ctx, null, state);
}

// ============================================================
// 3) Elegir hora
// ============================================================

async function handleHora(ctx, input, state) {
  if (!input) {
    const r = await handlers.consultar_horarios_disponibles(ctx, {
      provider_id: state.providerId,
      appointment_type_id: state.appointmentTypeId,
      fecha: state.date,
      exclude_appointment_id: state.appointmentId,
    });
    const slots = (r && !r.error && r.slots_disponibles) || [];

    if (slots.length === 0) {
      return {
        messages: [buildText('Justo se ocuparon los horarios de ese día. Elegí otro.')],
        transition: { to: 'reprogramar.dia', state },
      };
    }

    return {
      messages: [
        buildList(
          '¿A qué hora?',
          'Ver horarios',
          [{
            title: 'Horarios disponibles',
            rows: slots.slice(0, 10).map((s) => ({
              id: `rep.hora.${s.start_at}`,
              title: formatTimeLabelEs(s.start_at, ctx.timezone),
              description: s.etiqueta,
            })),
          }],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'list' && input.id?.startsWith('rep.hora.')) {
    const startAt = input.id.slice('rep.hora.'.length);
    return {
      messages: [],
      transition: {
        to: 'reprogramar.confirmacion',
        state: { ...state, newStartAt: startAt },
      },
    };
  }

  return await handleHora(ctx, null, state);
}

// ============================================================
// 4) Confirmación final
// ============================================================

async function handleConfirmacion(ctx, input, state) {
  if (!input) {
    const resumen =
      `Reprogramando:\n\n` +
      `• De ${state.oldCuando || formatShortDateTimeEs(state.oldStartAt, ctx.timezone)}\n` +
      `• A ${formatShortDateTimeEs(state.newStartAt, ctx.timezone)}\n` +
      (state.providerName ? `• Con ${state.providerName}\n` : '') +
      `\n¿Confirmamos el cambio?`;

    return {
      messages: [
        buildButtons(
          resumen,
          [
            { id: 'rep.conf.yes', title: 'Confirmar' },
            { id: 'rep.conf.no', title: 'Cancelar' },
          ],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'button' && input.id === 'rep.conf.yes') {
    const r = await handlers.reprogramar_cita(ctx, {
      appointment_id: state.appointmentId,
      start_at: state.newStartAt,
    });

    if (r?.error) {
      const errorMessages = {
        cita_ya_paso: 'Esa cita ya pasó, no se puede reprogramar.',
        muy_cerca: 'La cita original es en menos de 2 horas. Para cambios de último momento, contactá a la clínica.',
        cita_cancelada: 'La cita ya estaba cancelada.',
        no_autorizado: 'No pude verificar que la cita sea tuya.',
        double_booking: 'Otro paciente tomó ese horario. Elegí otro.',
      };
      const msg = errorMessages[r.error] || r.mensaje || 'No pude reprogramar la cita. Te paso con recepción.';

      if (r.error === 'double_booking') {
        return {
          messages: [buildText(msg)],
          transition: {
            to: 'reprogramar.dia',
            state: { ...state, date: null, newStartAt: null },
          },
        };
      }
      return {
        messages: [buildText(msg)],
        transition: r.error === 'muy_cerca' ? { to: 'escalar.confirmacion', state } : 'end',
      };
    }

    return {
      messages: [
        buildText(
          `¡Listo! Tu cita quedó reprogramada para ${r.cita?.nuevo_horario || formatShortDateTimeEs(state.newStartAt, ctx.timezone)}.`,
        ),
      ],
      transition: 'end',
    };
  }

  if (input.type === 'button' && input.id === 'rep.conf.no') {
    return {
      messages: [buildText('No reprogramo nada, tu cita queda como estaba.')],
      transition: 'end',
    };
  }

  return await handleConfirmacion(ctx, null, state);
}

// ============================================================
// Helper: fetch appointment basics (provider_id, appointment_type_id)
// ============================================================

const { supabase } = require('../../supabase');

async function fetchAppointmentBasics(ctx, appointmentId) {
  if (!appointmentId) return null;
  const { data } = await supabase
    .from('appointments')
    .select('id, provider_id, appointment_type_id, branch_id, organization_id, start_at, end_at, status')
    .eq('id', appointmentId)
    .maybeSingle();
  if (!data) return null;
  if (data.organization_id !== ctx.organizationId) return null;
  return data;
}

module.exports = {
  handlers: {
    'reprogramar.elegir_cita': handleElegirCita,
    'reprogramar.dia': handleDia,
    'reprogramar.hora': handleHora,
    'reprogramar.confirmacion': handleConfirmacion,
  },
};
