# bot-uzed — WhatsApp AI Bot (multi-tenant)

Bot conversacional para WhatsApp Cloud API que atiende pacientes de múltiples clínicas suscritas a **Uzed Health**. Una sola app Node.js sirve a muchas organizaciones: la org se identifica por el `phone_number_id` que Meta envía en cada webhook.

## Arquitectura

```
Paciente → WhatsApp → Meta Cloud API → POST /webhook (bot-uzed)
                                        ↓
                    Lookup: phone_number_id → organization_whatsapp_channels
                                        ↓
                    Org + branch + service_line + timezone (desde Supabase)
                                        ↓
                    Upsert conversation (wa_upsert_conversation RPC)
                                        ↓
                    Guardar inbound en whatsapp_messages
                                        ↓
                    ¿Conversación en human_handoff? → no responder
                                        ↓
                    Agent loop (Gemini / Claude) con tools scoped a la org
                                        ↓
                    Enviar reply + guardar outbound
```

### Tablas Supabase (ver migración `20260418030000_whatsapp_channels_and_inbox.sql`)

- `organization_whatsapp_channels` — mapea `phone_number_id` de Meta → organization/branch. Soporta modo `managed` (creds globales de Uzed) o `self_service` (creds propios de la org, cifrados).
- `whatsapp_conversations` — hilo por (canal, whatsapp del paciente). Estados: `bot_active`, `human_handoff`, `closed`.
- `whatsapp_messages` — historial completo (inbound + outbound), con idempotencia por `wamid`.
- `patients.whatsapp` — columna nueva para match por número de WhatsApp (separado del `phone` de contacto).

## Stack

- **Runtime**: Node.js 22 + Fastify 5 (cPanel Passenger)
- **DB**: Supabase (PostgreSQL + RLS) — cliente con `service_role` (el bot opera server-side)
- **LLM**: configurable via `LLM_PROVIDER`
  - `google` — Gemini 2.0 Flash (gratuito)
  - `anthropic` — Claude Haiku 4.5 (de pago)
- **TZ**: Luxon, con timezone leída de `organization_settings.timezone`

## Archivos

```
bot-uzed/
├─ server.js                    # Fastify + webhook Meta
├─ src/
│  ├─ route.js                  # Dispatcher: lee org_settings.whatsapp_bot_mode
│  ├─ agent.js                  # Bot IA (mode='ai') — LLM + tools
│  ├─ tools.js                  # Tools scoped por organization_id (IA y scripted)
│  ├─ whatsapp.js               # Cliente HTTP WA Cloud API (multi-tenant)
│  ├─ supabase.js               # Supabase client (service_role)
│  └─ scripted/                 # Bot guiado (mode='scripted') — sin LLM
│     ├─ index.js               # Entry point + dispatcher de pasos
│     ├─ lib.js                 # Helpers de disponibilidad / pacientes
│     ├─ messages.js            # Builders de text/buttons/list/flow
│     ├─ state.js               # Persistencia scripted_step/scripted_state
│     └─ steps/                 # Handlers por paso (menu, agendar, …)
├─ docs/flows/                  # WhatsApp Flows estáticos (opcionales)
│  └─ registro_paciente.json    # Mini-form de datos del paciente
├─ .env.example                 # Template de variables
├─ .env                         # Variables reales (no commitear)
└─ package.json
```

## Modos del bot (`org_settings.whatsapp_bot_mode`)

Cada organización decide desde su panel cómo responde el bot a los
mensajes entrantes:

| Mode | Comportamiento |
|---|---|
| `ai` (default) | Bot conversacional con LLM (Gemini/Claude). Plan **pago**. |
| `scripted` | Bot guiado con menú + botones + list messages. Plan **gratis**. |
| `hybrid` | Reservado para más adelante (actualmente cae a `ai`). |
| `off` | El bot no responde. Los inbounds se guardan para que el staff los atienda manualmente. |

El dispatcher (`src/route.js`) cachea el mode por canal 30s para evitar
queries repetidas. Para alternar rápido durante pruebas:

```sql
UPDATE public.org_settings
   SET whatsapp_bot_mode = 'scripted'  -- o 'ai' | 'hybrid' | 'off'
 WHERE org_id = '<uuid>';
```

### Flow opt-in para registro (solo `scripted`)

El step de registro de paciente acepta datos por mensajes secuenciales
(default) o vía un mini-form nativo (WhatsApp Flow estático). Para
habilitar el Flow: publicar `docs/flows/registro_paciente.json` en
WhatsApp Manager (ver `docs/flows/README.md`) y setear en `.env`:

```env
WHATSAPP_USE_FLOW_REGISTRO=true
WHATSAPP_FLOW_REGISTRO_ID=<id devuelto por Meta>
```

## Tools disponibles (espejo de la app Angular)

| Tool | Propósito |
|---|---|
| `listar_especialidades` | Especialidades activas, filtradas por `service_line` de la org |
| `listar_profesionales` | Médicos/odontólogos/veterinarios (por la línea de la org) |
| `listar_tipos_cita` | Tipos de consulta + duración en minutos |
| `consultar_horarios_disponibles` | Slots libres para un día, usando `provider_schedules` + `provider_blocked_times` + `appointments` (igual que `slot-generator.service.ts`) |
| `buscar_paciente` | Match por `(organization_id, whatsapp)` |
| `registrar_paciente` | Crea paciente (humano o mascota en clínicas veterinarias) |
| `agendar_cita` | Valida slot y crea appointment (calcula `end_at` desde `duration_minutes`) |
| `consultar_citas_paciente` | Próximas citas del paciente |
| `cancelar_cita` | Cancela (solo del propio paciente, scoped a la org) |
| `escalar_a_humano` | Marca conversación como `human_handoff` — el bot deja de responder |

## Setup local

```bash
cd bot-uzed
cp .env.example .env      # completar valores
npm install
npm start
```

Exponer con ngrok para desarrollo:

```bash
ngrok http 3000
# Configurar en Meta: https://<ngrok-url>/webhook
```

## Conectar una clínica (modo managed)

```sql
INSERT INTO public.organization_whatsapp_channels (
  organization_id, branch_id, phone_number_id, waba_id,
  display_phone_number, display_name, provisioning_mode, is_active
) VALUES (
  '<org-uuid>', '<branch-uuid>',
  '1141615449030701',          -- del panel de Meta
  '1169385901888483',
  '+57 301 234 5678',
  'Clínica Demo',
  'managed', true
);
```

El bot hace lookup por `phone_number_id` en cada webhook y responde con el token global (`WHATSAPP_ACCESS_TOKEN`).

## Capa 2 (futuro)

- Inbox dentro de Uzed Health (Angular) para que el staff supervise/intervenga.
- Realtime Supabase sobre `whatsapp_messages` para push.
- Endpoint para "tomar" conversaciones (`POST /conversations/:id/handoff`).
- Modo `self_service` con credenciales cifradas por org.
- Mensajes multimedia (imágenes, audio, documentos).
