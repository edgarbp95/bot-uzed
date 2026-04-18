-- ============================================================
-- Uzed Health — Esquema inicial de base de datos (Supabase)
-- Ejecutar en Supabase → SQL Editor → New Query → pegar → Run
-- ============================================================

-- Extensión para generar UUIDs
create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------
-- Especialidades
-- ------------------------------------------------------------
create table if not exists especialidades (
  id uuid primary key default uuid_generate_v4(),
  nombre text not null unique,
  activa boolean not null default true,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- Médicos
-- ------------------------------------------------------------
create table if not exists medicos (
  id uuid primary key default uuid_generate_v4(),
  nombre text not null,
  especialidad_id uuid references especialidades(id) on delete set null,
  cedula text,
  activo boolean not null default true,
  created_at timestamptz default now()
);

create index if not exists idx_medicos_especialidad on medicos(especialidad_id);

-- ------------------------------------------------------------
-- Horarios de disponibilidad del médico (plantilla semanal)
-- dia_semana: 0=domingo, 1=lunes, ..., 6=sábado (Date.getDay() en JS)
-- ------------------------------------------------------------
create table if not exists horarios_medico (
  id uuid primary key default uuid_generate_v4(),
  medico_id uuid not null references medicos(id) on delete cascade,
  dia_semana smallint not null check (dia_semana between 0 and 6),
  hora_inicio time not null,
  hora_fin time not null,
  duracion_cita_min int not null default 30,
  check (hora_fin > hora_inicio)
);

create index if not exists idx_horarios_medico on horarios_medico(medico_id, dia_semana);

-- ------------------------------------------------------------
-- Pacientes
-- ------------------------------------------------------------
create table if not exists pacientes (
  id uuid primary key default uuid_generate_v4(),
  nombre text not null,
  whatsapp text not null unique,
  email text,
  fecha_nacimiento date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ------------------------------------------------------------
-- Estados posibles de una cita
-- ------------------------------------------------------------
do $$ begin
  create type estado_cita as enum ('agendada', 'confirmada', 'cancelada', 'completada');
exception
  when duplicate_object then null;
end $$;

-- ------------------------------------------------------------
-- Citas
-- ------------------------------------------------------------
create table if not exists citas (
  id uuid primary key default uuid_generate_v4(),
  paciente_id uuid not null references pacientes(id) on delete restrict,
  medico_id uuid not null references medicos(id) on delete restrict,
  fecha_hora timestamptz not null,
  estado estado_cita not null default 'agendada',
  motivo text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_citas_medico_fecha on citas(medico_id, fecha_hora);
create index if not exists idx_citas_paciente on citas(paciente_id);
-- Evita agendar dos citas activas del mismo médico en la misma hora exacta
create unique index if not exists idx_citas_medico_fecha_activa
  on citas(medico_id, fecha_hora)
  where estado <> 'cancelada';

-- ------------------------------------------------------------
-- Trigger para updated_at en pacientes y citas
-- ------------------------------------------------------------
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_pacientes_updated on pacientes;
create trigger trg_pacientes_updated before update on pacientes
for each row execute function set_updated_at();

drop trigger if exists trg_citas_updated on citas;
create trigger trg_citas_updated before update on citas
for each row execute function set_updated_at();

-- ============================================================
-- SEED DATA — datos de ejemplo para empezar a probar
-- Puedes ajustar o borrar después
-- ============================================================

insert into especialidades (nombre) values
  ('Medicina General'),
  ('Cardiología'),
  ('Pediatría'),
  ('Ginecología'),
  ('Dermatología')
on conflict (nombre) do nothing;

-- Médico de ejemplo (Medicina General)
insert into medicos (nombre, especialidad_id)
select 'Dr. Juan Pérez', id from especialidades where nombre = 'Medicina General'
on conflict do nothing;

-- Horario del médico de ejemplo: Lunes a Viernes, 9:00 a 17:00, slots de 30 min
insert into horarios_medico (medico_id, dia_semana, hora_inicio, hora_fin, duracion_cita_min)
select m.id, dia, '09:00'::time, '17:00'::time, 30
from medicos m
cross join unnest(array[1,2,3,4,5]) as dia
where m.nombre = 'Dr. Juan Pérez'
on conflict do nothing;