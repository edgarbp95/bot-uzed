'use strict';

/**
 * src/scripted/lib.js
 *
 * Helpers puros del bot scripted. Combinan handlers ya existentes de
 * tools.js para resolver necesidades propias del flujo por menús:
 *
 *   - findAvailableDaysForProvider: próximos N días con al menos 1 slot
 *     libre, formateados para un list message.
 *   - listPatientFutureAppointments: citas futuras no canceladas del
 *     paciente identificado en la conversación.
 *   - resolveScriptedPatientId: devuelve el patient_id del paciente
 *     asociado a la conversación (ya sea por bot_last_identified o
 *     patient_id explícito, o por lookup por whatsapp).
 *   - formatters: etiquetas en español para días y horas (list rows).
 *   - parseBirthDateInput: parsea "12/05/1990" → "1990-05-12".
 *
 * IMPORTANTE: estos helpers NO tocan la lógica de agendar/reprogramar/
 * cancelar — eso sigue en tools.js → handlers. Acá solo se compone a
 * nivel superior para armar la UI del bot scripted.
 */

const { DateTime } = require('luxon');
const { supabase } = require('../supabase');
const { handlers, _internal } = require('../tools');
const { humanEs } = _internal;

const MAX_DAYS_IN_PICKER = 10; // WhatsApp list messages → máx 10 filas por sección
const DAYS_LOOKAHEAD = 30;     // Buscamos hasta 30 días para encontrar MAX_DAYS_IN_PICKER.

const DOW_ES_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTH_ES_SHORT = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
];

// ============================================================
// Resolución de patient_id asociado a la conversación
// ============================================================

/**
 * Busca el patient_id asociado a esta conversación, en orden:
 *   1. bot_last_identified_patient_id (el último paciente confirmado
 *      por el bot durante un flujo — puede ser distinto del dueño de la
 *      conversación si la persona agendó para un familiar).
 *   2. patient_id de la conversación (link permanente).
 *   3. Lookup por whatsapp en patients (paciente registrado que coincide
 *      con el número).
 *
 * Devuelve null si no hay match en ninguno.
 */
async function resolveScriptedPatientId(ctx) {
  if (!ctx?.conversationId) return null;

  const { data: conv } = await supabase
    .from('whatsapp_conversations')
    .select('bot_last_identified_patient_id, patient_id')
    .eq('id', ctx.conversationId)
    .maybeSingle();

  if (conv?.bot_last_identified_patient_id) return conv.bot_last_identified_patient_id;
  if (conv?.patient_id) return conv.patient_id;

  const lookup = await handlers.buscar_paciente(ctx);
  return lookup?.paciente?.id || null;
}

// ============================================================
// Citas futuras del paciente
// ============================================================

/**
 * Devuelve todas las citas futuras no canceladas del paciente, ordenadas
 * por start_at ascendente. Solo las que pertenezcan a la org del ctx.
 */
async function listPatientFutureAppointments(ctx, patientId) {
  if (!patientId) return [];

  const { data, error } = await supabase
    .from('appointments')
    .select(`
      id, start_at, end_at, status, notes,
      provider:providers(first_name, last_name),
      appointment_type:appointment_types(name)
    `)
    .eq('organization_id', ctx.organizationId)
    .eq('patient_id', patientId)
    .not('status', 'in', '("cancelled")')
    .gte('start_at', new Date().toISOString())
    .order('start_at')
    .limit(10);

  if (error) {
    console.error('[scripted/lib] listPatientFutureAppointments error:', error.message);
    return [];
  }

  return (data || []).map((a) => ({
    id: a.id,
    start_at: a.start_at,
    end_at: a.end_at,
    status: a.status,
    profesional: `${a.provider?.first_name || ''} ${a.provider?.last_name || ''}`.trim(),
    tipo: a.appointment_type?.name || null,
    cuando: humanEs(a.start_at, ctx.timezone),
  }));
}

// ============================================================
// Próximos días con disponibilidad (para list message de "elegí día")
// ============================================================

/**
 * Busca hasta MAX_DAYS_IN_PICKER días en los próximos DAYS_LOOKAHEAD con
 * al menos un slot libre para este profesional + tipo de cita.
 *
 * Optimización: primero consulta horarios_semanales_profesional para
 * saber qué days-of-week atiende, y solo evalúa esos días. Luego corre
 * consultar_horarios_disponibles en paralelo (Promise.all) para esos
 * candidatos. Si un día tiene >=1 slot, lo incluye.
 *
 * Devuelve: [{ date: "2026-04-21", label: "Lun 21 abr", slots_count: 5 }, ...]
 */
async function findAvailableDaysForProvider(ctx, {
  provider_id,
  appointment_type_id,
  max_days = MAX_DAYS_IN_PICKER,
  lookahead = DAYS_LOOKAHEAD,
  exclude_appointment_id = null,
} = {}) {
  if (!provider_id || !appointment_type_id) return [];

  // 1) Qué days-of-week atiende el profesional
  const weekly = await handlers.horarios_semanales_profesional(ctx, { provider_id });
  if (!weekly || weekly.error || !weekly.atiende) return [];
  const dowAttends = new Set((weekly.dias || []).map((d) => d.dia_num));

  // 2) Armo la lista de fechas candidatas (próximos `lookahead` días)
  const tz = ctx.timezone;
  const today = DateTime.now().setZone(tz).startOf('day');
  const candidates = [];
  for (let i = 0; i < lookahead; i++) {
    const day = today.plus({ days: i });
    // Luxon dayNumber: 1=lunes..7=domingo. La tool usa 0=dom..6=sáb (JS Date.getDay).
    // Convertimos: lunes(1) → 1, martes(2) → 2, ..., domingo(7) → 0.
    const dow = day.weekday === 7 ? 0 : day.weekday;
    if (!dowAttends.has(dow)) continue;
    candidates.push(day);
    // Corto temprano si ya tengo suficientes candidatos. Cada candidato
    // después pasa por consultar_horarios_disponibles que es costoso (2
    // queries por llamada). Con un poco de holgura (2x max_days) evito
    // sobrellamadas pero dejo margen por días sin slots libres.
    if (candidates.length >= max_days * 2) break;
  }

  // 3) Consultar disponibilidad real para cada candidato (en paralelo)
  const results = await Promise.all(
    candidates.map(async (day) => {
      const ymd = day.toFormat('yyyy-LL-dd');
      const r = await handlers.consultar_horarios_disponibles(ctx, {
        provider_id,
        appointment_type_id,
        fecha: ymd,
        ...(exclude_appointment_id ? { exclude_appointment_id } : {}),
      });
      const slots = (r && !r.error && r.slots_disponibles) ? r.slots_disponibles : [];
      return { day, ymd, slotsCount: slots.length };
    }),
  );

  // 4) Filtrar a los que tienen slots y devolver los primeros max_days
  const withSlots = results.filter((r) => r.slotsCount > 0).slice(0, max_days);
  return withSlots.map((r) => ({
    date: r.ymd,
    label: formatDayLabelEs(r.day),
    slots_count: r.slotsCount,
  }));
}

// ============================================================
// Formatters para list messages
// ============================================================

/** "Lun 21 abr" — bien compacto para que entre en el title de una list row (24 chars). */
function formatDayLabelEs(dtOrIso, tz = null) {
  const dt = typeof dtOrIso === 'string'
    ? DateTime.fromISO(dtOrIso, tz ? { zone: tz } : undefined)
    : dtOrIso;
  const dowIdx = dt.weekday === 7 ? 0 : dt.weekday;
  const dow = capitalize(DOW_ES_SHORT[dowIdx]);
  const month = MONTH_ES_SHORT[dt.month - 1];
  return `${dow} ${dt.day} ${month}`;
}

/** "09:00" */
function formatTimeLabelEs(isoOrDt, tz) {
  const dt = typeof isoOrDt === 'string'
    ? DateTime.fromISO(isoOrDt, { zone: tz })
    : isoOrDt;
  return dt.toFormat('HH:mm');
}

/** "Hoy 15:30" / "Mañana 09:00" / "Mié 23 abr 14:00" — para confirmaciones */
function formatShortDateTimeEs(iso, tz) {
  return humanEs(iso, tz);
}

function capitalize(s) {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}

// ============================================================
// Parsing de fecha de nacimiento (para flujo sequential)
// ============================================================

/**
 * Acepta "DD/MM/AAAA", "DD-MM-AAAA", "AAAA-MM-DD". Devuelve ISO
 * "AAAA-MM-DD" o null si no se puede parsear o si la fecha es
 * inválida (ej. 32/13/2000).
 */
function parseBirthDateInput(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // AAAA-MM-DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const dt = DateTime.fromObject({
      year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    });
    return dt.isValid ? dt.toFormat('yyyy-LL-dd') : null;
  }

  // DD/MM/AAAA o DD-MM-AAAA
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const dt = DateTime.fromObject({
      year: Number(m[3]), month: Number(m[2]), day: Number(m[1]),
    });
    return dt.isValid ? dt.toFormat('yyyy-LL-dd') : null;
  }

  return null;
}

// ============================================================
// Especialidades que tienen al menos un profesional activo
// ============================================================

/**
 * Filtra `listar_especialidades` devolviendo solo las que tienen al menos
 * un profesional activo asignado. Evita mostrarle al paciente especialidades
 * "huecas" (la clínica las tiene en el catálogo pero no contrató médicos).
 *
 * Costo: 2 queries en paralelo (especialidades + profesionales sin filtrar).
 * Aceptable porque los dos listados están cacheados in-memory con TTL
 * (ver _internal.cacheListar en tools.js) y son chicos (<200 rows cada uno).
 */
async function listSpecialtiesWithProviders(ctx) {
  const [espRes, profRes] = await Promise.all([
    handlers.listar_especialidades(ctx),
    handlers.listar_profesionales(ctx),
  ]);
  const withProviders = new Set(
    (profRes?.profesionales || [])
      .map((p) => p.especialidad_id)
      .filter(Boolean),
  );
  return (espRes?.especialidades || []).filter((s) => withProviders.has(s.id));
}

module.exports = {
  // Constantes
  MAX_DAYS_IN_PICKER,
  DAYS_LOOKAHEAD,
  // Lookup
  resolveScriptedPatientId,
  listPatientFutureAppointments,
  findAvailableDaysForProvider,
  listSpecialtiesWithProviders,
  // Formatters
  formatDayLabelEs,
  formatTimeLabelEs,
  formatShortDateTimeEs,
  // Parsers
  parseBirthDateInput,
};
