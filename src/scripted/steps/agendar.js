'use strict';

/**
 * src/scripted/steps/agendar.js — Flujo scripted de agendar cita.
 *
 * Sub-steps (en orden):
 *   1. agendar.especialidad      → list (solo muestra especialidades con
 *                                   al menos 1 profesional; saltable si hay 1)
 *   2. agendar.profesional       → list (saltable si hay 1 solo en la esp.)
 *   3. agendar.tipo              → list (saltable si hay 1 solo)
 *   4. agendar.dia               → list (próx 10 días con slots)
 *   5. agendar.hora              → list (slots del día)
 *   6. agendar.paciente_confirmar → buttons (si hay match por whatsapp)
 *   7a. agendar.registro.*       → 4 pasos secuenciales de texto
 *   7b. agendar.registro_flow    → (si WHATSAPP_USE_FLOW_REGISTRO=true)
 *   8. agendar.confirmacion      → buttons [Confirmar] [Cancelar]
 *
 * Orden deliberado: especialidad → profesional → tipo → día.
 * Primero el paciente elige "con quién" (más importante para él), después
 * el tipo de consulta (control, primera vez, etc.), después el día/hora.
 *
 * Prefijos de IDs en respuestas del usuario:
 *   agd.esp.<uuid>, agd.tipo.<uuid>, agd.prof.<uuid>,
 *   agd.dia.<yyyy-MM-dd>, agd.hora.<iso>,
 *   agd.conf.yes / agd.conf.no / agd.conf.cancel,
 *   agd.pac.yes / agd.pac.no / agd.pac.cancel
 */

const { handlers } = require('../../tools');
const {
  buildText,
  buildButtons,
  buildList,
  buildFlow,
} = require('../messages');
const {
  findAvailableDaysForProvider,
  listSpecialtiesWithProviders,
  formatTimeLabelEs,
  formatShortDateTimeEs,
  parseBirthDateInput,
} = require('../lib');

// Si esta env var está en 'true' y WHATSAPP_FLOW_REGISTRO_ID está seteado,
// el registro de paciente usa Flow en vez del camino secuencial.
function useFlowForRegistro() {
  const enabled = process.env.WHATSAPP_USE_FLOW_REGISTRO === 'true'
    && !!process.env.WHATSAPP_FLOW_REGISTRO_ID;
  // Log de una sola vez por proceso para facilitar debug del setup en cPanel.
  if (!useFlowForRegistro._logged) {
    console.log(
      '[scripted] Flow registro paciente: %s (WHATSAPP_USE_FLOW_REGISTRO=%s, WHATSAPP_FLOW_REGISTRO_ID=%s)',
      enabled ? 'ENABLED' : 'DISABLED',
      process.env.WHATSAPP_USE_FLOW_REGISTRO,
      process.env.WHATSAPP_FLOW_REGISTRO_ID ? '<set>' : '<missing>',
    );
    useFlowForRegistro._logged = true;
  }
  return enabled;
}

// ============================================================
// 1) Especialidad
// ============================================================

async function handleEspecialidad(ctx, input, state) {
  if (!input) {
    // Filtramos las especialidades "huecas": si no hay un profesional activo
    // asignado, no tiene sentido ofrecerla (el paciente la elegiría y después
    // el bot se ahogaría en "no hay profesionales para esa especialidad").
    const items = await listSpecialtiesWithProviders(ctx);
    if (items.length === 0) {
      return {
        messages: [
          buildText(
            'Todavía no tenemos profesionales configurados en el sistema. ' +
            'Te paso con recepción para que te ayuden.',
          ),
        ],
        transition: { to: 'escalar.confirmacion', state: {} },
      };
    }
    if (items.length === 1) {
      const only = items[0];
      return {
        messages: [],
        transition: {
          to: 'agendar.profesional',
          state: {
            ...state,
            specialtyId: only.id,
            specialtyName: only.nombre,
          },
        },
      };
    }

    return {
      messages: [
        buildList(
          'Perfecto, te ayudo a agendar tu cita. ¿Qué especialidad estás buscando?',
          'Ver especialidades',
          [{
            title: 'Especialidades',
            rows: items.map((s) => ({
              id: `agd.esp.${s.id}`,
              title: s.nombre,
              description: s.categoria || undefined,
            })),
          }],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'list' && input.id?.startsWith('agd.esp.')) {
    const id = input.id.slice('agd.esp.'.length);
    return {
      messages: [],
      transition: {
        to: 'agendar.profesional',
        state: {
          ...state,
          specialtyId: id,
          specialtyName: input.title || null,
        },
      },
    };
  }

  return await handleEspecialidad(ctx, null, state);
}

// ============================================================
// 2) Tipo de cita
// ============================================================

async function handleTipo(ctx, input, state) {
  if (!input) {
    const r = await handlers.listar_tipos_cita(ctx);
    const items = r?.tipos_cita || [];
    if (items.length === 0) {
      return {
        messages: [
          buildText(
            'No tenemos tipos de consulta configurados todavía. ' +
            'Te paso con recepción para que te ayuden.',
          ),
        ],
        transition: { to: 'escalar.confirmacion', state: {} },
      };
    }
    if (items.length === 1) {
      const only = items[0];
      return {
        messages: [],
        transition: {
          to: 'agendar.dia',
          state: {
            ...state,
            appointmentTypeId: only.id,
            appointmentTypeName: only.nombre,
            durationMin: only.duracion_min,
          },
        },
      };
    }

    // Header dinámico: si ya elegimos profesional, lo mencionamos para que
    // el paciente tenga contexto de con quién va a ser la cita.
    const bodyText = state.providerName
      ? `Excelente, con ${state.providerName}. ¿Qué tipo de consulta vas a necesitar?`
      : '¿Qué tipo de consulta vas a necesitar?';

    return {
      messages: [
        buildList(
          bodyText,
          'Ver tipos',
          [{
            title: 'Tipos de cita',
            rows: items.map((t) => ({
              id: `agd.tipo.${t.id}`,
              title: t.nombre,
              description: t.duracion_min ? `${t.duracion_min} min` : undefined,
            })),
          }],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'list' && input.id?.startsWith('agd.tipo.')) {
    const id = input.id.slice('agd.tipo.'.length);
    // Re-fetch duration — title del list no lo trae
    const r = await handlers.listar_tipos_cita(ctx);
    const t = (r?.tipos_cita || []).find((x) => x.id === id);
    return {
      messages: [],
      transition: {
        to: 'agendar.dia',
        state: {
          ...state,
          appointmentTypeId: id,
          appointmentTypeName: t?.nombre || input.title || null,
          durationMin: t?.duracion_min || null,
        },
      },
    };
  }

  return await handleTipo(ctx, null, state);
}

// ============================================================
// 3) Profesional
// ============================================================

async function handleProfesional(ctx, input, state) {
  if (!input) {
    const r = await handlers.listar_profesionales(ctx, {
      especialidad_id: state.specialtyId,
    });
    const items = r?.profesionales || [];
    if (items.length === 0) {
      return {
        messages: [
          buildText(
            'Por ahora no tenemos profesionales disponibles para esa especialidad. ' +
            'Te paso con recepción para que te orienten.',
          ),
        ],
        transition: { to: 'escalar.confirmacion', state: {} },
      };
    }
    if (items.length === 1) {
      // Único profesional: skip silencioso. El header del próximo step
      // (agendar.tipo) menciona el nombre del profesional, así que el
      // paciente igual se entera con quién va sin necesidad de un mensaje
      // extra que sume ruido.
      const only = items[0];
      return {
        messages: [],
        transition: {
          to: 'agendar.tipo',
          state: {
            ...state,
            providerId: only.id,
            providerName: only.nombre,
          },
        },
      };
    }

    return {
      messages: [
        buildList(
          `¿Con qué profesional te gustaría agendar${state.specialtyName ? ` de ${state.specialtyName}` : ''}?`,
          'Ver profesionales',
          [{
            title: 'Profesionales',
            rows: items.map((p) => ({
              id: `agd.prof.${p.id}`,
              title: p.nombre,
              description: p.especialidad || undefined,
            })),
          }],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'list' && input.id?.startsWith('agd.prof.')) {
    const id = input.id.slice('agd.prof.'.length);
    return {
      messages: [],
      transition: {
        to: 'agendar.tipo',
        state: {
          ...state,
          providerId: id,
          providerName: input.title || null,
        },
      },
    };
  }

  return await handleProfesional(ctx, null, state);
}

// ============================================================
// 4) Día
// ============================================================

async function handleDia(ctx, input, state) {
  if (!input) {
    const days = await findAvailableDaysForProvider(ctx, {
      provider_id: state.providerId,
      appointment_type_id: state.appointmentTypeId,
    });

    if (days.length === 0) {
      return {
        messages: [
          buildText(
            `Revisé la agenda y ${state.providerName || 'el profesional'} no tiene horarios ` +
            `disponibles en los próximos 30 días para ${state.appointmentTypeName || 'este tipo de consulta'}. ` +
            'Te paso con recepción para ver alternativas, ¿te parece?',
          ),
        ],
        transition: { to: 'escalar.confirmacion', state: {} },
      };
    }

    return {
      messages: [
        buildList(
          `¿Qué día te viene bien para ver a ${state.providerName || 'el profesional'}?`,
          'Ver días',
          [{
            title: 'Próximos días',
            rows: days.map((d) => ({
              id: `agd.dia.${d.date}`,
              title: d.label,
              description: `${d.slots_count} horario${d.slots_count === 1 ? '' : 's'}`,
            })),
          }],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'list' && input.id?.startsWith('agd.dia.')) {
    const date = input.id.slice('agd.dia.'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return await handleDia(ctx, null, state);
    }
    return {
      messages: [],
      transition: {
        to: 'agendar.hora',
        state: { ...state, date },
      },
    };
  }

  return await handleDia(ctx, null, state);
}

// ============================================================
// 5) Hora
// ============================================================

async function handleHora(ctx, input, state) {
  if (!input) {
    const r = await handlers.consultar_horarios_disponibles(ctx, {
      provider_id: state.providerId,
      appointment_type_id: state.appointmentTypeId,
      fecha: state.date,
    });
    const slots = (r && !r.error && r.slots_disponibles) || [];

    if (slots.length === 0) {
      // Raro — venimos de handleDia que ya filtró. Fallback: volver a elegir día.
      return {
        messages: [
          buildText('Uy, justo se ocuparon los horarios de ese día. Elegí otro día, así seguimos.'),
        ],
        transition: { to: 'agendar.dia', state },
      };
    }

    // WhatsApp list: máx 10 rows. Si hay más, truncamos.
    const rows = slots.slice(0, 10).map((s) => ({
      id: `agd.hora.${s.start_at}`,
      title: formatTimeLabelEs(s.start_at, ctx.timezone),
      description: s.etiqueta,
    }));

    return {
      messages: [
        buildList(
          'Elegí el horario que mejor te quede:',
          'Ver horarios',
          [{ title: 'Horarios disponibles', rows }],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'list' && input.id?.startsWith('agd.hora.')) {
    const startAt = input.id.slice('agd.hora.'.length);
    return {
      messages: [],
      transition: {
        to: 'agendar.paciente_confirmar',
        state: {
          ...state,
          startAt,
          slotLabel: input.title || formatTimeLabelEs(startAt, ctx.timezone),
        },
      },
    };
  }

  return await handleHora(ctx, null, state);
}

// ============================================================
// 6) Confirmar paciente (si hay match por whatsapp)
// ============================================================

async function handlePacienteConfirmar(ctx, input, state) {
  if (!input) {
    // Buscar paciente por whatsapp (número del contacto)
    const r = await handlers.buscar_paciente(ctx);
    if (!r?.paciente) {
      // No hay paciente — directo a registro
      return {
        messages: [],
        transition: {
          to: useFlowForRegistro() ? 'agendar.registro_flow' : 'agendar.registro.first_name',
          state,
        },
      };
    }

    const p = r.paciente;
    return {
      messages: [
        buildButtons(
          `Para ir más rápido: ¿la cita es para ${p.nombre}?`,
          [
            { id: 'agd.pac.yes', title: 'Sí, soy yo' },
            { id: 'agd.pac.no', title: 'No, otra persona' },
            { id: 'agd.pac.cancel', title: 'Cancelar' },
          ],
        ),
      ],
      transition: 'stay',
      state: {
        ...state,
        // Recordamos el candidato; lo usamos si el usuario dice "sí"
        candidatePatientId: p.id,
        candidatePatientName: p.nombre,
      },
    };
  }

  if (input.type === 'button') {
    if (input.id === 'agd.pac.yes' && state.candidatePatientId) {
      return {
        messages: [],
        transition: {
          to: 'agendar.confirmacion',
          state: {
            ...state,
            patientId: state.candidatePatientId,
            patientName: state.candidatePatientName,
          },
        },
      };
    }
    if (input.id === 'agd.pac.no') {
      // "Otra persona" = el paciente NO es el dueño del WhatsApp.
      // Marcamos registrarForSelf=false para que registrar_paciente NO
      // haga el early-return con el paciente existente del whatsapp y
      // NO asocie el whatsapp del contacto al paciente nuevo.
      return {
        messages: [],
        transition: {
          to: useFlowForRegistro() ? 'agendar.registro_flow' : 'agendar.registro.first_name',
          state: { ...state, registrarForSelf: false },
        },
      };
    }
    if (input.id === 'agd.pac.cancel') {
      return {
        messages: [buildText('Sin problema, no agendo nada. Cuando quieras volver a intentarlo, escribime y seguimos.')],
        transition: 'end',
      };
    }
  }

  return await handlePacienteConfirmar(ctx, null, state);
}

// ============================================================
// 7a) Registro secuencial (default)
// ============================================================

async function handleRegistroFirstName(ctx, input, state) {
  if (!input) {
    return {
      messages: [buildText('Perfecto. Te registro rápidamente así reservamos el turno — ¿cuál es tu nombre?')],
      transition: 'stay',
      state,
    };
  }
  if (input.type === 'text') {
    const name = String(input.text || '').trim();
    if (!name) return await handleRegistroFirstName(ctx, null, state);
    return {
      messages: [],
      transition: {
        to: 'agendar.registro.last_name',
        state: { ...state, registro: { ...(state.registro || {}), first_name: name } },
      },
    };
  }
  return await handleRegistroFirstName(ctx, null, state);
}

async function handleRegistroLastName(ctx, input, state) {
  if (!input) {
    return {
      messages: [buildText('Gracias. ¿Y tu apellido?')],
      transition: 'stay',
      state,
    };
  }
  if (input.type === 'text') {
    const name = String(input.text || '').trim();
    if (!name) return await handleRegistroLastName(ctx, null, state);
    return {
      messages: [],
      transition: {
        to: 'agendar.registro.birth_date',
        state: { ...state, registro: { ...(state.registro || {}), last_name: name } },
      },
    };
  }
  return await handleRegistroLastName(ctx, null, state);
}

async function handleRegistroBirthDate(ctx, input, state) {
  if (!input) {
    return {
      messages: [buildText('¿Cuál es tu fecha de nacimiento? Escribila en formato DD/MM/AAAA (por ejemplo 12/05/1990).')],
      transition: 'stay',
      state,
    };
  }
  if (input.type === 'text') {
    const iso = parseBirthDateInput(input.text || '');
    if (!iso) {
      return {
        messages: [buildText('Disculpá, no logré entender la fecha. ¿Podés escribirla así: DD/MM/AAAA? (por ejemplo 12/05/1990)')],
        transition: 'stay',
        state,
      };
    }
    return {
      messages: [],
      transition: {
        to: 'agendar.registro.city',
        state: { ...state, registro: { ...(state.registro || {}), birth_date: iso } },
      },
    };
  }
  return await handleRegistroBirthDate(ctx, null, state);
}

async function handleRegistroCity(ctx, input, state) {
  if (!input) {
    return {
      messages: [buildText('¿En qué ciudad vivís? Si preferís no decirlo, escribí "omitir".')],
      transition: 'stay',
      state,
    };
  }
  if (input.type === 'text') {
    const raw = String(input.text || '').trim();
    const city = /^(omitir|saltar|no|\-)$/i.test(raw) ? null : raw || null;
    return {
      messages: [],
      transition: {
        to: 'agendar.registro.email',
        state: { ...state, registro: { ...(state.registro || {}), city } },
      },
    };
  }
  return await handleRegistroCity(ctx, null, state);
}

async function handleRegistroEmail(ctx, input, state) {
  if (!input) {
    return {
      messages: [buildText('Por último, ¿me dejás un email para enviarte los recordatorios? Es opcional — escribí "omitir" si preferís no compartirlo.')],
      transition: 'stay',
      state,
    };
  }
  if (input.type === 'text') {
    const raw = String(input.text || '').trim();
    const email = /^(omitir|saltar|no|\-)$/i.test(raw) ? null : (raw.includes('@') ? raw.toLowerCase() : null);

    // Registrar paciente con lo capturado.
    // for_self: default true (paciente = dueño del whatsapp). Si el usuario
    // dijo "No, otra persona" en paciente_confirmar, llega registrarForSelf=false.
    const r = await handlers.registrar_paciente(ctx, {
      first_name: state.registro?.first_name,
      last_name: state.registro?.last_name,
      birth_date: state.registro?.birth_date,
      city: state.registro?.city,
      email: email || undefined,
      for_self: state.registrarForSelf !== false,
    });

    if (r?.error || !r?.paciente?.id) {
      return {
        messages: [
          buildText(
            'Uy, tuve un inconveniente guardando tus datos. Te paso con recepción para que te ayuden.',
          ),
        ],
        transition: { to: 'escalar.confirmacion', state },
      };
    }

    return {
      messages: [],
      transition: {
        to: 'agendar.confirmacion',
        state: {
          ...state,
          patientId: r.paciente.id,
          patientName: r.paciente.nombre,
        },
      },
    };
  }
  return await handleRegistroEmail(ctx, null, state);
}

// ============================================================
// 7b) Registro via Flow (opt-in)
// ============================================================

async function handleRegistroFlow(ctx, input, state) {
  if (!input) {
    const flowId = process.env.WHATSAPP_FLOW_REGISTRO_ID;
    if (!flowId) {
      // Safety net: si la env var no está, caemos a secuencial
      return {
        messages: [],
        transition: { to: 'agendar.registro.first_name', state },
      };
    }
    return {
      messages: [
        buildFlow(
          'Para terminar de agendarte, te pido unos datos rápidos. Tocá el botón de abajo y lo completás en un toque:',
          {
            flowId,
            flowToken: ctx.conversationId,
            cta: 'Completar datos',
            initialScreen: 'DATOS_PACIENTE',
          },
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'flow' && input.flowResponse) {
    const data = input.flowResponse;
    const r = await handlers.registrar_paciente(ctx, {
      first_name: data.first_name,
      last_name: data.last_name,
      birth_date: data.birth_date,
      phone: data.phone || undefined,
      email: data.email || undefined,
      for_self: state.registrarForSelf !== false,
    });

    if (r?.error || !r?.paciente?.id) {
      return {
        messages: [
          buildText('Uy, tuve un inconveniente guardando tus datos. Te paso con recepción para que te ayuden.'),
        ],
        transition: { to: 'escalar.confirmacion', state },
      };
    }

    return {
      messages: [],
      transition: {
        to: 'agendar.confirmacion',
        state: {
          ...state,
          patientId: r.paciente.id,
          patientName: r.paciente.nombre,
        },
      },
    };
  }

  // Si el usuario mandó texto en vez de abrir el Flow, re-enviamos el flow.
  return await handleRegistroFlow(ctx, null, state);
}

// ============================================================
// 8) Confirmación final
// ============================================================

async function handleConfirmacion(ctx, input, state) {
  if (!input) {
    const resumen =
      `Te resumo la cita antes de confirmar:\n\n` +
      `• ${state.appointmentTypeName || 'Cita'}${state.specialtyName ? ` (${state.specialtyName})` : ''}\n` +
      `• Con ${state.providerName || 'el profesional'}\n` +
      `• ${formatShortDateTimeEs(state.startAt, ctx.timezone)}\n` +
      `• Paciente: ${state.patientName || 'vos'}\n\n` +
      `¿La confirmamos?`;

    return {
      messages: [
        buildButtons(
          resumen,
          [
            { id: 'agd.conf.yes', title: 'Confirmar' },
            { id: 'agd.conf.no', title: 'Cancelar' },
          ],
        ),
      ],
      transition: 'stay',
      state,
    };
  }

  if (input.type === 'button' && input.id === 'agd.conf.yes') {
    const r = await handlers.agendar_cita(ctx, {
      provider_id: state.providerId,
      patient_id: state.patientId,
      appointment_type_id: state.appointmentTypeId,
      start_at: state.startAt,
      specialty_id: state.specialtyId || null,
      notes: null,
    });

    if (r?.error) {
      const msg =
        r.error === 'double_booking'
          ? 'Uh, justo otra persona reservó ese horario antes. Arranquemos de nuevo para buscarte otro.'
          : r.mensaje || 'No logré agendar la cita. Te paso con recepción para que te ayuden.';
      if (r.error === 'double_booking') {
        return {
          messages: [buildText(msg)],
          transition: {
            to: 'agendar.dia',
            state: { ...state, date: null, startAt: null, slotLabel: null },
          },
        };
      }
      return {
        messages: [buildText(msg)],
        transition: { to: 'escalar.confirmacion', state },
      };
    }

    const nombreCita = r.cita?.tipo || state.appointmentTypeName || 'tu cita';
    const msgOk =
      `¡Listo! 🎉 Tu ${nombreCita} quedó agendada para ${r.cita?.cuando || formatShortDateTimeEs(state.startAt, ctx.timezone)} ` +
      `con ${r.cita?.profesional || state.providerName}.\n\n` +
      `Te vamos a estar esperando. Si más adelante necesitás reprogramar o cancelar, escribime y te ayudo.`;

    return {
      messages: [buildText(msgOk)],
      transition: 'end',
    };
  }

  if (input.type === 'button' && input.id === 'agd.conf.no') {
    return {
      messages: [buildText('Sin problema, no agendo nada. Cuando quieras volver a intentarlo, escribime y seguimos.')],
      transition: 'end',
    };
  }

  return await handleConfirmacion(ctx, null, state);
}

module.exports = {
  handlers: {
    'agendar.especialidad': handleEspecialidad,
    'agendar.tipo': handleTipo,
    'agendar.profesional': handleProfesional,
    'agendar.dia': handleDia,
    'agendar.hora': handleHora,
    'agendar.paciente_confirmar': handlePacienteConfirmar,
    'agendar.registro.first_name': handleRegistroFirstName,
    'agendar.registro.last_name': handleRegistroLastName,
    'agendar.registro.birth_date': handleRegistroBirthDate,
    'agendar.registro.city': handleRegistroCity,
    'agendar.registro.email': handleRegistroEmail,
    'agendar.registro_flow': handleRegistroFlow,
    'agendar.confirmacion': handleConfirmacion,
  },
};
