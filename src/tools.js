'use strict';

/**
 * Tools del bot — multi-tenant, conectadas al esquema real de Uzed Health.
 *
 * Cada handler recibe (ctx, input):
 *   ctx = {
 *     organizationId,   // uuid de la org (clínica)
 *     branchId,         // uuid de la sucursal por defecto del canal (puede ser null)
 *     serviceLine,      // 'medical' | 'dental' | 'veterinary' (de la org)
 *     timezone,         // ej: 'America/Bogota'
 *     whatsapp,         // número del paciente en E.164 sin "+"
 *     conversationId,   // uuid de whatsapp_conversations
 *   }
 *
 * Todas las queries van scoped por organization_id (Supabase con service_role,
 * pero igualmente filtramos para defender contra cross-tenant leaks).
 *
 * Replica la lógica de src/app/features/appointments/slot-generator.service.ts
 * en TypeScript: provider_schedules + provider_blocked_times + appointments,
 * todo en la TZ de la org.
 */

const { DateTime } = require('luxon');
const { supabase } = require('./supabase');

// ============================================================
// Helpers de tiempo (espejo de core/time/timezone.utils.ts)
// ============================================================

/** Devuelve 0=domingo..6=sábado para una fecha YYYY-MM-DD interpretada en `tz`. */
function dayOfWeekInTz(ymd, tz) {
  const dt = DateTime.fromISO(ymd, { zone: tz });
  // Luxon: 1=Mon..7=Sun → JS: 0=Sun..6=Sat
  return dt.weekday === 7 ? 0 : dt.weekday;
}

/** YYYY-MM-DD + HH:MM en `tz` → ISO UTC. */
function isoFromLocalInTz(ymd, hhmm, tz) {
  const [h, m] = hhmm.split(':').map(Number);
  return DateTime.fromISO(ymd, { zone: tz })
    .set({ hour: h, minute: m, second: 0, millisecond: 0 })
    .toUTC()
    .toISO();
}

/** ISO → componentes locales en `tz`. */
function localInTz(iso, tz) {
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz);
  return {
    ymd: dt.toFormat('yyyy-LL-dd'),
    hhmm: dt.toFormat('HH:mm'),
    dayOfWeek: dt.weekday === 7 ? 0 : dt.weekday,
    hours: dt.hour,
    minutes: dt.minute,
  };
}

/** ISO → "lunes 20 de abril a las 10:30 am" en español. */
function humanEs(iso, tz) {
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz).setLocale('es');
  const fecha = dt.toFormat("cccc d 'de' LLLL");
  const hora = dt.toFormat('h:mm a').toLowerCase();
  return `${fecha} a las ${hora}`;
}

/** Minutos absolutos (ej: 630) → "10:30". */
function minsToHHMM(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** "10:30" → 630. */
function hhmmToMins(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ============================================================
// Helpers de normalización
// ============================================================

/** Limpia un número (quita +, espacios, guiones). Devuelve null si no es válido. */
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

/** Igual que normalizePhone pero pensado para WhatsApp (E.164 sin "+"). */
function normalizeWhatsapp(raw) {
  return normalizePhone(raw);
}

// ============================================================
// validateSlot interno — espejo de slot-generator.service.ts#validateSlot
// ============================================================

async function validateSlotInternal(ctx, { providerId, branchId, startAtIso, endAtIso, excludeAppointmentId }) {
  const tz = ctx.timezone;
  const startLocal = localInTz(startAtIso, tz);
  const endLocal = localInTz(endAtIso, tz);
  const dayOfWeek = startLocal.dayOfWeek;
  const startHHMM = minsToHHMM(startLocal.hours * 60 + startLocal.minutes);
  const endHHMM = minsToHHMM(endLocal.hours * 60 + endLocal.minutes);

  // 1) Dentro de algún provider_schedule activo
  const { data: schedules } = await supabase
    .from('provider_schedules')
    .select('start_time, end_time')
    .eq('organization_id', ctx.organizationId)
    .eq('provider_id', providerId)
    .eq('branch_id', branchId)
    .eq('day_of_week', dayOfWeek)
    .eq('is_active', true);

  const inSchedule = (schedules || []).some((s) => {
    const sStart = String(s.start_time).slice(0, 5);
    const sEnd = String(s.end_time).slice(0, 5);
    return startHHMM >= sStart && endHHMM <= sEnd;
  });
  if (!inSchedule) return { ok: false, reason: 'out_of_schedule' };

  // 2) Sin double-booking
  let q = supabase
    .from('appointments')
    .select('id')
    .eq('provider_id', providerId)
    .not('status', 'in', '("cancelled")')
    .lt('start_at', endAtIso)
    .gt('end_at', startAtIso);
  if (excludeAppointmentId) q = q.neq('id', excludeAppointmentId);
  const { data: overlaps } = await q;
  if ((overlaps || []).length > 0) return { ok: false, reason: 'double_booking' };

  // 3) Sin blocked_time
  const { data: blocks } = await supabase
    .from('provider_blocked_times')
    .select('id')
    .eq('provider_id', providerId)
    .lt('start_at', endAtIso)
    .gt('end_at', startAtIso);
  if ((blocks || []).length > 0) return { ok: false, reason: 'blocked_time' };

  return { ok: true };
}

// ============================================================
// Tool definitions (Anthropic format)
// ============================================================

const tools = [
  {
    name: 'listar_especialidades',
    description:
      'Lista las especialidades activas de la clínica (filtra por la línea de servicio: médica/odontológica/veterinaria). Úsala cuando el paciente pregunte por servicios o tipos de profesionales.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'listar_profesionales',
    description:
      'Lista profesionales activos de la clínica, opcionalmente filtrados por especialidad. Para clínicas dentales devuelve odontólogos, para veterinarias veterinarios, etc.',
    input_schema: {
      type: 'object',
      properties: {
        especialidad_id: {
          type: 'string',
          description: 'UUID de la especialidad (opcional). Si se omite devuelve todos.',
        },
      },
      required: [],
    },
  },
  {
    name: 'listar_tipos_cita',
    description:
      'Lista los tipos de cita configurados por la clínica (ej: Consulta general, Control, Limpieza, Vacunación). Cada uno tiene su duración en minutos. SIEMPRE pregunta al paciente qué tipo necesita antes de buscar horarios — la duración importa para los slots.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'consultar_horarios_disponibles',
    description:
      'Consulta horarios libres de un profesional para una fecha específica, considerando sus turnos, citas existentes y bloqueos. Devuelve los slots libres en lenguaje humano. Llámala UNA fecha a la vez (no rangos largos) para no saturar al paciente.',
    input_schema: {
      type: 'object',
      properties: {
        provider_id: { type: 'string', description: 'UUID del profesional.' },
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD.' },
        appointment_type_id: {
          type: 'string',
          description:
            'UUID del tipo de cita. Necesario para saber la duración. Si no lo tienes aún, llama listar_tipos_cita primero.',
        },
      },
      required: ['provider_id', 'fecha', 'appointment_type_id'],
    },
  },
  {
    name: 'buscar_paciente',
    description:
      'Busca el paciente por su número de WhatsApp dentro de esta clínica. SIEMPRE llámala al inicio de un nuevo flujo de agendamiento — si devuelve null, debes registrarlo con registrar_paciente antes de agendar.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'registrar_paciente',
    description:
      'Registra un paciente nuevo en esta clínica. Pide: nombre, apellido (opcional), y al menos UNO de (teléfono internacional o email). Para clínicas veterinarias usa patient_kind="animal" (first_name = nombre de la mascota) y completa owner_first_name/owner_last_name (datos del dueño). NO pidas especie ni raza al paciente — la recepcionista los completa después.',
    input_schema: {
      type: 'object',
      properties: {
        first_name: { type: 'string', description: 'Nombre del paciente. Para vet: nombre de la mascota.' },
        last_name: { type: 'string', description: 'Apellido del paciente (opcional). Para vet: omitir.' },
        phone: {
          type: 'string',
          description: 'Teléfono internacional (con o sin "+", el sistema normaliza). Opcional si das email.',
        },
        email: { type: 'string', description: 'Email (opcional si das phone).' },
        patient_kind: {
          type: 'string',
          enum: ['human', 'animal'],
          description: 'Por defecto "human". Usa "animal" SOLO si la org es veterinaria.',
        },
        owner_first_name: {
          type: 'string',
          description: 'Solo para patient_kind=animal: nombre del dueño de la mascota.',
        },
        owner_last_name: {
          type: 'string',
          description: 'Solo para patient_kind=animal: apellido del dueño.',
        },
      },
      required: ['first_name'],
    },
  },
  {
    name: 'agendar_cita',
    description:
      'Agenda una cita. ANTES de llamar esto: (1) el paciente debe estar registrado, (2) el horario debe haber sido confirmado por el paciente. La función valida que el slot esté libre (turno activo, sin double-booking, sin bloqueo).',
    input_schema: {
      type: 'object',
      properties: {
        patient_id: { type: 'string', description: 'UUID del paciente (de buscar_paciente o registrar_paciente).' },
        provider_id: { type: 'string', description: 'UUID del profesional.' },
        appointment_type_id: { type: 'string', description: 'UUID del tipo de cita.' },
        specialty_id: { type: 'string', description: 'UUID de la especialidad (opcional).' },
        start_at: {
          type: 'string',
          description:
            'ISO 8601 con TZ del slot elegido (lo recibiste de consultar_horarios_disponibles). Ej: 2026-04-25T10:30:00-05:00',
        },
        notes: { type: 'string', description: 'Motivo o nota breve del paciente (opcional).' },
      },
      required: ['patient_id', 'provider_id', 'appointment_type_id', 'start_at'],
    },
  },
  {
    name: 'consultar_citas_paciente',
    description:
      'Lista las próximas citas (no canceladas) del paciente actual en esta clínica. Útil cuando pregunta "¿cuándo es mi cita?" o "¿qué citas tengo?".',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cancelar_cita',
    description:
      'Cancela una cita por su UUID. Pide al paciente confirmación antes de llamar esto. Solo se pueden cancelar citas del propio paciente.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'UUID de la cita.' },
        motivo: { type: 'string', description: 'Motivo de la cancelación (opcional).' },
      },
      required: ['appointment_id'],
    },
  },
  {
    name: 'escalar_a_humano',
    description:
      'Escala la conversación a un humano (recepcionista). Úsala cuando: el paciente pide hablar con una persona, hay quejas, facturación, dudas médicas complejas, o cualquier cosa fuera del alcance del bot. Marca la conversación como handoff y deja de responder.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Resumen breve del motivo del escalamiento.' },
      },
      required: ['motivo'],
    },
  },
];

// ============================================================
// Handlers
// ============================================================

const handlers = {
  // ── Especialidades ────────────────────────────────────────────────────────
  async listar_especialidades(ctx) {
    // service_line de specialties puede ser ServiceLine | 'all'.
    // Mostrar las propias de la línea de la org + las marcadas como 'all'.
    const { data, error } = await supabase
      .from('specialties')
      .select('id, name, category, service_line, sort_order')
      .eq('organization_id', ctx.organizationId)
      .eq('is_active', true)
      .in('service_line', [ctx.serviceLine, 'all'])
      .order('sort_order')
      .order('name');
    if (error) throw error;

    return {
      especialidades: (data || []).map((s) => ({
        id: s.id,
        nombre: s.name,
        categoria: s.category,
      })),
    };
  },

  // ── Profesionales ─────────────────────────────────────────────────────────
  async listar_profesionales(ctx, { especialidad_id } = {}) {
    let q = supabase
      .from('providers')
      .select('id, first_name, last_name, provider_type, specialty_id, specialty:specialties(id, name)')
      .eq('organization_id', ctx.organizationId)
      .eq('is_active', true);

    if (especialidad_id) q = q.eq('specialty_id', especialidad_id);

    const { data, error } = await q.order('last_name');
    if (error) throw error;

    return {
      profesionales: (data || []).map((p) => ({
        id: p.id,
        nombre: `${p.first_name} ${p.last_name}`.trim(),
        tipo: p.provider_type,
        especialidad: p.specialty?.name || null,
        especialidad_id: p.specialty_id,
      })),
    };
  },

  // ── Tipos de cita ─────────────────────────────────────────────────────────
  async listar_tipos_cita(ctx) {
    // service_line en appointment_types puede ser ServiceLine | 'all' | null.
    // Aceptamos los de la línea, los 'all' y los null (genéricos).
    const { data, error } = await supabase
      .from('appointment_types')
      .select('id, name, duration_minutes, service_line, sort_order')
      .eq('organization_id', ctx.organizationId)
      .eq('is_active', true)
      .or(`service_line.eq.${ctx.serviceLine},service_line.eq.all,service_line.is.null`)
      .order('sort_order')
      .order('name');
    if (error) throw error;

    return {
      tipos_cita: (data || []).map((t) => ({
        id: t.id,
        nombre: t.name,
        duracion_min: t.duration_minutes,
      })),
    };
  },

  // ── Horarios disponibles ──────────────────────────────────────────────────
  async consultar_horarios_disponibles(ctx, { provider_id, fecha, appointment_type_id }) {
    const tz = ctx.timezone;
    const branchId = ctx.branchId;

    if (!branchId) {
      return { error: 'no_branch_configured', mensaje: 'El canal de WhatsApp no tiene sucursal asignada.' };
    }

    // 1) Tipo de cita → duración
    const { data: apptType, error: errT } = await supabase
      .from('appointment_types')
      .select('id, name, duration_minutes')
      .eq('organization_id', ctx.organizationId)
      .eq('id', appointment_type_id)
      .maybeSingle();
    if (errT) throw errT;
    if (!apptType) return { error: 'tipo_cita_no_encontrado' };

    const requiredMins = apptType.duration_minutes;
    const dayOfWeek = dayOfWeekInTz(fecha, tz);

    // 2) provider_schedules de ese día/branch/provider
    const { data: schedules } = await supabase
      .from('provider_schedules')
      .select('start_time, end_time, slot_duration_minutes')
      .eq('organization_id', ctx.organizationId)
      .eq('provider_id', provider_id)
      .eq('branch_id', branchId)
      .eq('day_of_week', dayOfWeek)
      .eq('is_active', true);

    if (!schedules || schedules.length === 0) {
      return {
        slots_disponibles: [],
        nota: `El profesional no atiende el ${DateTime.fromISO(fecha, { zone: tz }).setLocale('es').toFormat("cccc d 'de' LLLL")}.`,
      };
    }

    // 3) Bordes del día en TZ org
    const dayStart = isoFromLocalInTz(fecha, '00:00', tz);
    const dayEnd = isoFromLocalInTz(fecha, '23:59', tz);

    const [apptRes, blockedRes] = await Promise.all([
      supabase
        .from('appointments')
        .select('id, start_at, end_at, status')
        .eq('provider_id', provider_id)
        .gte('start_at', dayStart)
        .lte('start_at', dayEnd)
        .not('status', 'in', '("cancelled")'),
      supabase
        .from('provider_blocked_times')
        .select('id, start_at, end_at')
        .eq('provider_id', provider_id)
        .lt('start_at', dayEnd)
        .gt('end_at', dayStart),
    ]);

    const busy = (apptRes.data || []).map((a) => ({
      start: new Date(a.start_at).getTime(),
      end: new Date(a.end_at).getTime(),
    }));
    const blocked = (blockedRes.data || []).map((b) => ({
      start: new Date(b.start_at).getTime(),
      end: new Date(b.end_at).getTime(),
    }));

    // 4) Expandir bloques en slots libres
    const nowMs = Date.now();
    const free = [];
    for (const sched of schedules) {
      const slotMins = Math.max(requiredMins, sched.slot_duration_minutes);
      const blockStart = hhmmToMins(String(sched.start_time).slice(0, 5));
      const blockEnd = hhmmToMins(String(sched.end_time).slice(0, 5));

      for (let m = blockStart; m + slotMins <= blockEnd; m += sched.slot_duration_minutes) {
        const startHHMM = minsToHHMM(m);
        const endHHMM = minsToHHMM(m + requiredMins);
        const startIso = isoFromLocalInTz(fecha, startHHMM, tz);
        const endIso = isoFromLocalInTz(fecha, endHHMM, tz);
        const sStart = new Date(startIso).getTime();
        const sEnd = new Date(endIso).getTime();

        if (sStart <= nowMs) continue; // saltar slots pasados

        const overlap =
          busy.some((b) => b.start < sEnd && sStart < b.end) ||
          blocked.some((b) => b.start < sEnd && sStart < b.end);

        if (!overlap) {
          free.push({
            start_at: startIso,
            end_at: endIso,
            etiqueta: humanEs(startIso, tz),
          });
        }

        if (free.length >= 12) break;
      }
      if (free.length >= 12) break;
    }

    return {
      slots_disponibles: free,
      tipo_cita: { id: apptType.id, nombre: apptType.name, duracion_min: apptType.duration_minutes },
    };
  },

  // ── Buscar paciente (por whatsapp del ctx) ────────────────────────────────
  async buscar_paciente(ctx) {
    const wa = normalizeWhatsapp(ctx.whatsapp);
    if (!wa) return { paciente: null };

    const { data, error } = await supabase
      .from('patients')
      .select(`
        id, first_name, last_name, email, phone, patient_kind,
        species:species(name),
        breed:breeds(name),
        owner:owners(first_name, last_name)
      `)
      .eq('organization_id', ctx.organizationId)
      .eq('whatsapp', wa)
      .maybeSingle();
    if (error) throw error;

    if (!data) return { paciente: null };
    return {
      paciente: {
        id: data.id,
        nombre: `${data.first_name} ${data.last_name || ''}`.trim(),
        first_name: data.first_name,
        last_name: data.last_name,
        email: data.email,
        phone: data.phone,
        patient_kind: data.patient_kind,
        especie: data.species?.name || null,
        raza: data.breed?.name || null,
        dueno: data.owner ? `${data.owner.first_name} ${data.owner.last_name}`.trim() : null,
      },
    };
  },

  // ── Registrar paciente ────────────────────────────────────────────────────
  // Para veterinaria: crea un owner (si no viene uno existente) y luego el patient
  // con owner_id. Especie y raza las completa la recepcionista más tarde — aquí
  // solo capturamos lo mínimo para identificar a la mascota y contactar al dueño.
  async registrar_paciente(ctx, input) {
    const wa = normalizeWhatsapp(ctx.whatsapp);
    if (!wa) return { error: 'whatsapp_invalido' };

    const phone = input.phone ? normalizePhone(input.phone) : null;
    const email = input.email && String(input.email).includes('@') ? String(input.email).trim() : null;

    if (!phone && !email) {
      return {
        error: 'falta_contacto',
        mensaje: 'Necesitamos al menos un teléfono internacional o un email para registrarte.',
      };
    }

    // Si ya existe por (org, whatsapp), devolverlo sin duplicar
    const existing = await handlers.buscar_paciente(ctx);
    if (existing.paciente) return { paciente: existing.paciente, ya_existia: true };

    // Determinar patient_kind: respetar input si la org es veterinaria
    const kind =
      input.patient_kind === 'animal' && ctx.serviceLine === 'veterinary'
        ? 'animal'
        : 'human';

    const payload = {
      organization_id: ctx.organizationId,
      first_name: String(input.first_name).trim(),
      last_name: input.last_name ? String(input.last_name).trim() : null,
      whatsapp: wa,
      phone,
      email,
      patient_kind: kind,
    };

    // Veterinaria: crear owner con datos del dueño (teléfono/email para contacto)
    if (kind === 'animal') {
      const ownerFirst = input.owner_first_name
        ? String(input.owner_first_name).trim()
        : (phone || email ? 'Dueño' : null);
      const ownerLast = input.owner_last_name ? String(input.owner_last_name).trim() : null;

      if (!ownerFirst) {
        return {
          error: 'falta_dueno',
          mensaje: 'Para registrar a la mascota necesito el nombre del dueño.',
        };
      }

      const { data: owner, error: ownerErr } = await supabase
        .from('owners')
        .insert({
          organization_id: ctx.organizationId,
          first_name: ownerFirst,
          last_name: ownerLast,
          phone,
          email,
          is_active: true,
        })
        .select('id')
        .single();
      if (ownerErr) return { error: ownerErr.message || 'error_creando_owner' };

      payload.owner_id = owner.id;
      // species_id y breed_id se dejan NULL — la recepcionista los completa luego
    }

    const { data, error } = await supabase
      .from('patients')
      .insert(payload)
      .select('id, first_name, last_name, email, phone, patient_kind')
      .single();
    if (error) return { error: error.message || 'error_al_registrar' };

    // Linkear conversación con el paciente recién creado
    if (ctx.conversationId) {
      await supabase
        .from('whatsapp_conversations')
        .update({ patient_id: data.id })
        .eq('id', ctx.conversationId)
        .is('patient_id', null);
    }

    return {
      paciente: {
        id: data.id,
        nombre: `${data.first_name} ${data.last_name || ''}`.trim(),
        email: data.email,
        phone: data.phone,
        patient_kind: data.patient_kind,
      },
      mensaje: 'Paciente registrado.',
    };
  },

  // ── Agendar cita ──────────────────────────────────────────────────────────
  async agendar_cita(ctx, input) {
    const branchId = ctx.branchId;
    if (!branchId) return { error: 'no_branch_configured' };

    // 1) Resolver tipo de cita → duración
    const { data: apptType, error: errT } = await supabase
      .from('appointment_types')
      .select('id, name, duration_minutes')
      .eq('organization_id', ctx.organizationId)
      .eq('id', input.appointment_type_id)
      .maybeSingle();
    if (errT) throw errT;
    if (!apptType) return { error: 'tipo_cita_no_encontrado' };

    // 2) Calcular end_at desde duración
    const startDt = DateTime.fromISO(input.start_at);
    if (!startDt.isValid) return { error: 'fecha_invalida' };
    const endIso = startDt.plus({ minutes: apptType.duration_minutes }).toISO();
    const startIso = startDt.toISO();

    // 3) Validar el slot (igual que en la app web)
    const validation = await validateSlotInternal(ctx, {
      providerId: input.provider_id,
      branchId,
      startAtIso: startIso,
      endAtIso: endIso,
    });
    if (!validation.ok) {
      const reasonMsg = {
        out_of_schedule: 'El horario está fuera de los turnos del profesional.',
        double_booking: 'Otro paciente acaba de tomar ese horario, por favor elige otro.',
        blocked_time: 'El profesional tiene un bloqueo en ese horario.',
      };
      return {
        error: validation.reason,
        mensaje: reasonMsg[validation.reason] || 'Horario no disponible.',
      };
    }

    // 4) Insertar cita
    const { data, error } = await supabase
      .from('appointments')
      .insert({
        organization_id: ctx.organizationId,
        branch_id: branchId,
        patient_id: input.patient_id,
        provider_id: input.provider_id,
        appointment_type_id: input.appointment_type_id,
        specialty_id: input.specialty_id || null,
        start_at: startIso,
        end_at: endIso,
        status: 'scheduled',
        notes: input.notes || null,
      })
      .select(
        'id, start_at, end_at, status, notes, provider:providers(first_name, last_name), appointment_type:appointment_types(name)'
      )
      .single();
    if (error) {
      if (error.message && error.message.includes('no_provider_double_booking')) {
        return { error: 'double_booking', mensaje: 'Otro paciente acaba de tomar ese horario.' };
      }
      return { error: error.message || 'error_al_agendar' };
    }

    return {
      cita: {
        id: data.id,
        cuando: humanEs(data.start_at, ctx.timezone),
        profesional: `${data.provider.first_name} ${data.provider.last_name}`.trim(),
        tipo: data.appointment_type?.name,
      },
      mensaje: 'Cita agendada.',
    };
  },

  // ── Consultar citas del paciente ──────────────────────────────────────────
  async consultar_citas_paciente(ctx) {
    const me = await handlers.buscar_paciente(ctx);
    if (!me.paciente) return { citas: [], nota: 'No encontré tu registro como paciente.' };

    const { data, error } = await supabase
      .from('appointments')
      .select(
        'id, start_at, end_at, status, notes, provider:providers(first_name, last_name), appointment_type:appointment_types(name)'
      )
      .eq('organization_id', ctx.organizationId)
      .eq('patient_id', me.paciente.id)
      .not('status', 'in', '("cancelled")')
      .gte('start_at', new Date().toISOString())
      .order('start_at')
      .limit(10);
    if (error) throw error;

    return {
      citas: (data || []).map((a) => ({
        id: a.id,
        cuando: humanEs(a.start_at, ctx.timezone),
        profesional: `${a.provider.first_name} ${a.provider.last_name}`.trim(),
        tipo: a.appointment_type?.name,
        estado: a.status,
      })),
    };
  },

  // ── Cancelar cita ─────────────────────────────────────────────────────────
  async cancelar_cita(ctx, { appointment_id, motivo }) {
    // Verificar que la cita es de este paciente / org
    const me = await handlers.buscar_paciente(ctx);
    if (!me.paciente) return { error: 'paciente_no_registrado' };

    const { data: appt } = await supabase
      .from('appointments')
      .select('id, patient_id, organization_id, status, start_at')
      .eq('id', appointment_id)
      .maybeSingle();
    if (!appt) return { error: 'cita_no_encontrada' };
    if (appt.organization_id !== ctx.organizationId || appt.patient_id !== me.paciente.id) {
      return { error: 'no_autorizado' };
    }
    if (appt.status === 'cancelled') return { error: 'ya_estaba_cancelada' };

    const { error } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: motivo || 'Cancelada por el paciente vía WhatsApp',
      })
      .eq('id', appointment_id);
    if (error) return { error: error.message };

    return {
      mensaje: 'Cita cancelada.',
      cita: { id: appointment_id, cuando: humanEs(appt.start_at, ctx.timezone) },
    };
  },

  // ── Escalar a humano ──────────────────────────────────────────────────────
  async escalar_a_humano(ctx, { motivo }) {
    if (!ctx.conversationId) return { error: 'no_conversation' };

    const { error } = await supabase
      .from('whatsapp_conversations')
      .update({
        status: 'human_handoff',
        last_message_preview: `[handoff] ${motivo}`.slice(0, 200),
      })
      .eq('id', ctx.conversationId);
    if (error) return { error: error.message };

    return {
      escalado: true,
      mensaje:
        'Listo, le aviso al equipo para que te atienda lo antes posible. Mantente atento por aquí.',
    };
  },
};

// ============================================================
// Dispatcher + trazabilidad a DB
// ============================================================
// Cada invocación queda registrada en `whatsapp_tool_invocations`
// para poder diagnosticar alucinaciones y errores sin depender
// del stderr.log de cPanel (Passenger no captura console.log).

async function logInvocation({ ctx, tool, input, output, error, durationMs }) {
  if (!ctx?.organizationId) return; // sin org no hay dónde loggear
  try {
    await supabase.from('whatsapp_tool_invocations').insert({
      organization_id: ctx.organizationId,
      conversation_id: ctx.conversationId || null,
      tool,
      input: input || null,
      output: output || null,
      error: error || null,
      duration_ms: typeof durationMs === 'number' ? Math.round(durationMs) : null,
    });
  } catch (logErr) {
    // No rompemos el flujo si falla el logging
    console.error(`[tool-log] fallo insert para ${tool}:`, logErr?.message);
  }
}

async function executeTool(name, input, ctx) {
  const startedAt = Date.now();

  if (!handlers[name]) {
    const output = { error: `tool_desconocido: ${name}` };
    await logInvocation({
      ctx, tool: name, input, output, error: 'tool_desconocido',
      durationMs: Date.now() - startedAt,
    });
    return output;
  }

  try {
    const output = await handlers[name](ctx, input || {});
    await logInvocation({
      ctx, tool: name, input, output,
      error: output && output.error ? String(output.error) : null,
      durationMs: Date.now() - startedAt,
    });
    return output;
  } catch (err) {
    const errMsg = err?.message || 'error_interno';
    console.error(`[tool ${name}] error:`, err);
    await logInvocation({
      ctx, tool: name, input,
      output: { error: errMsg },
      error: `${errMsg}\n${err?.stack || ''}`.slice(0, 4000),
      durationMs: Date.now() - startedAt,
    });
    return { error: errMsg };
  }
}

// ============================================================
// Gemini format (parameters en vez de input_schema)
// ============================================================
//
// Gemini v1beta rechaza function declarations con `properties: {}` vacío.
// Para tools sin params, omitimos el campo `parameters` por completo.
// También quitamos `required: []` cuando está vacío.

function toGeminiParameters(schema) {
  if (!schema || !schema.properties || Object.keys(schema.properties).length === 0) {
    return undefined; // tool sin parámetros
  }
  const out = { type: schema.type || 'object', properties: schema.properties };
  if (schema.required && schema.required.length > 0) out.required = schema.required;
  return out;
}

const geminiTools = tools.map((t) => {
  const decl = { name: t.name, description: t.description };
  const params = toGeminiParameters(t.input_schema);
  if (params) decl.parameters = params;
  return decl;
});

module.exports = {
  tools,
  geminiTools,
  executeTool,
  // expuestos para tests/debug
  _internal: {
    dayOfWeekInTz,
    isoFromLocalInTz,
    localInTz,
    humanEs,
    minsToHHMM,
    hhmmToMins,
    normalizePhone,
    normalizeWhatsapp,
    validateSlotInternal,
  },
};
