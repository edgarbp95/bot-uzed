'use strict';

const { supabase } = require('./supabase');

/**
 * Tool definitions for Claude (Anthropic tool use format)
 */
const tools = [
  {
    name: 'listar_especialidades',
    description:
      'Lista todas las especialidades médicas activas en Uzed Health. Úsala cuando el paciente pregunte qué especialidades hay o qué tipo de médicos se atienden.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'listar_medicos',
    description:
      'Lista médicos activos, opcionalmente filtrados por especialidad. Úsala cuando el paciente quiera ver médicos disponibles en una especialidad específica.',
    input_schema: {
      type: 'object',
      properties: {
        especialidad_id: {
          type: 'string',
          description:
            'UUID de la especialidad. Si se omite, devuelve todos los médicos activos.',
        },
      },
      required: [],
    },
  },
  {
    name: 'consultar_horarios_disponibles',
    description:
      'Consulta horarios libres de un médico en un rango de fechas. Devuelve máximo 20 slots. Úsala cuando ya sepas con qué médico quiere agendar el paciente.',
    input_schema: {
      type: 'object',
      properties: {
        medico_id: { type: 'string', description: 'UUID del médico.' },
        fecha_inicio: {
          type: 'string',
          description: 'Fecha de inicio en formato YYYY-MM-DD.',
        },
        fecha_fin: {
          type: 'string',
          description: 'Fecha de fin en formato YYYY-MM-DD (máximo 14 días después del inicio).',
        },
      },
      required: ['medico_id', 'fecha_inicio', 'fecha_fin'],
    },
  },
  {
    name: 'registrar_paciente',
    description:
      'Registra un paciente nuevo o actualiza uno existente usando el número de WhatsApp como identificador único. Llámala ANTES de agendar si el paciente no está registrado.',
    input_schema: {
      type: 'object',
      properties: {
        whatsapp: {
          type: 'string',
          description: 'Número de WhatsApp del paciente (con código de país, sin +).',
        },
        nombre: { type: 'string', description: 'Nombre completo del paciente.' },
        email: { type: 'string', description: 'Email del paciente (opcional).' },
      },
      required: ['whatsapp', 'nombre'],
    },
  },
  {
    name: 'buscar_paciente',
    description:
      'Busca un paciente por su número de WhatsApp para ver si ya está registrado.',
    input_schema: {
      type: 'object',
      properties: {
        whatsapp: { type: 'string', description: 'Número de WhatsApp del paciente.' },
      },
      required: ['whatsapp'],
    },
  },
  {
    name: 'agendar_cita',
    description:
      'Agenda una nueva cita. El paciente DEBE estar registrado previamente. Valida que el horario esté libre antes de confirmar.',
    input_schema: {
      type: 'object',
      properties: {
        whatsapp_paciente: {
          type: 'string',
          description: 'Número de WhatsApp del paciente.',
        },
        medico_id: { type: 'string', description: 'UUID del médico.' },
        fecha_hora: {
          type: 'string',
          description:
            'Fecha y hora de la cita en ISO 8601 con zona horaria, ej: 2026-04-25T10:30:00-06:00',
        },
        motivo: {
          type: 'string',
          description: 'Motivo breve de la consulta (opcional).',
        },
      },
      required: ['whatsapp_paciente', 'medico_id', 'fecha_hora'],
    },
  },
  {
    name: 'consultar_citas_paciente',
    description:
      'Lista las próximas citas (no canceladas) de un paciente. Úsala cuando el paciente pregunte por sus citas.',
    input_schema: {
      type: 'object',
      properties: {
        whatsapp_paciente: {
          type: 'string',
          description: 'Número de WhatsApp del paciente.',
        },
      },
      required: ['whatsapp_paciente'],
    },
  },
  {
    name: 'cancelar_cita',
    description: 'Cancela una cita usando su ID (UUID).',
    input_schema: {
      type: 'object',
      properties: {
        cita_id: { type: 'string', description: 'UUID de la cita a cancelar.' },
      },
      required: ['cita_id'],
    },
  },
];

/**
 * Tool handler implementations — the real logic that talks to Supabase.
 */
const handlers = {
  async listar_especialidades() {
    const { data, error } = await supabase
      .from('especialidades')
      .select('id, nombre')
      .eq('activa', true)
      .order('nombre');
    if (error) throw error;
    return { especialidades: data };
  },

  async listar_medicos({ especialidad_id }) {
    let query = supabase
      .from('medicos')
      .select('id, nombre, especialidad:especialidades(id, nombre)')
      .eq('activo', true);
    if (especialidad_id) query = query.eq('especialidad_id', especialidad_id);
    const { data, error } = await query.order('nombre');
    if (error) throw error;
    return { medicos: data };
  },

  async consultar_horarios_disponibles({ medico_id, fecha_inicio, fecha_fin }) {
    const { data: horarios, error: errH } = await supabase
      .from('horarios_medico')
      .select('*')
      .eq('medico_id', medico_id);
    if (errH) throw errH;
    if (!horarios || horarios.length === 0) {
      return { slots_disponibles: [], nota: 'El médico no tiene horarios configurados.' };
    }

    const inicioIso = `${fecha_inicio}T00:00:00Z`;
    const finIso = `${fecha_fin}T23:59:59Z`;

    const { data: citas, error: errC } = await supabase
      .from('citas')
      .select('fecha_hora')
      .eq('medico_id', medico_id)
      .gte('fecha_hora', inicioIso)
      .lte('fecha_hora', finIso)
      .neq('estado', 'cancelada');
    if (errC) throw errC;

    const ocupados = new Set((citas || []).map((c) => new Date(c.fecha_hora).getTime()));

    const slots = [];
    const start = new Date(`${fecha_inicio}T00:00:00`);
    const end = new Date(`${fecha_fin}T23:59:59`);
    const now = new Date();

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const diaSemana = d.getDay();
      const horariosDelDia = horarios.filter((h) => h.dia_semana === diaSemana);

      for (const h of horariosDelDia) {
        const [hIni, mIni] = h.hora_inicio.split(':').map(Number);
        const [hFin, mFin] = h.hora_fin.split(':').map(Number);
        const dur = h.duracion_cita_min || 30;

        const slotStart = new Date(d);
        slotStart.setHours(hIni, mIni, 0, 0);
        const endLimit = new Date(d);
        endLimit.setHours(hFin, mFin, 0, 0);

        let cursor = new Date(slotStart);
        while (cursor < endLimit) {
          if (cursor > now && !ocupados.has(cursor.getTime())) {
            slots.push(cursor.toISOString());
          }
          cursor = new Date(cursor.getTime() + dur * 60000);
          if (slots.length >= 20) break;
        }
        if (slots.length >= 20) break;
      }
      if (slots.length >= 20) break;
    }

    return { slots_disponibles: slots };
  },

  async buscar_paciente({ whatsapp }) {
    const { data, error } = await supabase
      .from('pacientes')
      .select('id, nombre, email')
      .eq('whatsapp', whatsapp)
      .maybeSingle();
    if (error) throw error;
    return { paciente: data };
  },

  async registrar_paciente({ whatsapp, nombre, email }) {
    const { data, error } = await supabase
      .from('pacientes')
      .upsert({ whatsapp, nombre, email }, { onConflict: 'whatsapp' })
      .select()
      .single();
    if (error) throw error;
    return { paciente: data };
  },

  async agendar_cita({ whatsapp_paciente, medico_id, fecha_hora, motivo }) {
    const { data: paciente, error: errP } = await supabase
      .from('pacientes')
      .select('id, nombre')
      .eq('whatsapp', whatsapp_paciente)
      .maybeSingle();
    if (errP) throw errP;
    if (!paciente) {
      return {
        error: 'Paciente no encontrado. Regístralo primero con registrar_paciente.',
      };
    }

    const { data: citaExistente } = await supabase
      .from('citas')
      .select('id')
      .eq('medico_id', medico_id)
      .eq('fecha_hora', fecha_hora)
      .neq('estado', 'cancelada')
      .maybeSingle();
    if (citaExistente) {
      return { error: 'Ese horario ya está ocupado. Pide al paciente otro horario.' };
    }

    const { data, error } = await supabase
      .from('citas')
      .insert({
        paciente_id: paciente.id,
        medico_id,
        fecha_hora,
        motivo: motivo || null,
        estado: 'agendada',
      })
      .select(
        'id, fecha_hora, estado, motivo, medico:medicos(nombre, especialidad:especialidades(nombre))'
      )
      .single();
    if (error) throw error;
    return { cita: data, mensaje: 'Cita agendada con éxito.' };
  },

  async consultar_citas_paciente({ whatsapp_paciente }) {
    const { data: paciente } = await supabase
      .from('pacientes')
      .select('id')
      .eq('whatsapp', whatsapp_paciente)
      .maybeSingle();
    if (!paciente) return { citas: [] };

    const { data, error } = await supabase
      .from('citas')
      .select(
        'id, fecha_hora, estado, motivo, medico:medicos(nombre, especialidad:especialidades(nombre))'
      )
      .eq('paciente_id', paciente.id)
      .neq('estado', 'cancelada')
      .gte('fecha_hora', new Date().toISOString())
      .order('fecha_hora');
    if (error) throw error;
    return { citas: data };
  },

  async cancelar_cita({ cita_id }) {
    const { data, error } = await supabase
      .from('citas')
      .update({ estado: 'cancelada' })
      .eq('id', cita_id)
      .select()
      .single();
    if (error) throw error;
    return { cita: data, mensaje: 'Cita cancelada.' };
  },
};

async function executeTool(name, input) {
  if (!handlers[name]) {
    return { error: `Tool desconocido: ${name}` };
  }
  try {
    return await handlers[name](input || {});
  } catch (error) {
    console.error(`Tool ${name} failed:`, error);
    return { error: error.message || 'Error interno al ejecutar la herramienta.' };
  }
}

/**
 * Mismas tools en formato Google Gemini (function calling).
 * La unica diferencia con Anthropic es `parameters` vs `input_schema`.
 */
const geminiTools = tools.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.input_schema,
}));

module.exports = { tools, geminiTools, executeTool };