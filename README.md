# bot-uzed — WhatsApp AI Bot para Uzed Health

Bot conversacional en WhatsApp para Uzed Health. Permite a pacientes consultar médicos, ver disponibilidad y agendar/cancelar citas de forma conversacional. Usa Claude Haiku como LLM y Supabase como base de datos.

## Stack

- Node.js 22 + Fastify (HTTP server)
- WhatsApp Cloud API (Meta)
- Anthropic Claude Haiku 4.5 con tool use
- Supabase (PostgreSQL + API)

## Estructura

```
bot-uzed/
├── server.js                 # Entry point, webhook de WhatsApp
├── package.json              # Dependencias
├── .env.example              # Plantilla de variables de entorno
├── .gitignore
├── supabase-schema.sql       # Script SQL para crear las tablas
├── README.md
└── src/
    ├── whatsapp.js           # Cliente WhatsApp Cloud API
    ├── supabase.js           # Cliente Supabase
    ├── conversations.js      # Historial de conversación en memoria
    ├── tools.js              # Definiciones y handlers de las tools del agente
    └── agent.js              # Loop del agente Claude con tool use
```

## Despliegue en cPanel (paso a paso)

### 1. Crear las tablas en Supabase

1. Entra al dashboard de tu proyecto Supabase
2. **SQL Editor** → **New Query**
3. Pega el contenido de `supabase-schema.sql`
4. Clic en **Run**
5. Verifica en **Table Editor** que se crearon: `especialidades`, `medicos`, `horarios_medico`, `pacientes`, `citas`

### 2. Subir el código a GitHub

Desde tu máquina local (o subiendo archivos por la UI de GitHub):

```bash
git clone https://github.com/edgarbp95/bot-uzed.git
cd bot-uzed
# copia los archivos de este proyecto aquí
git add .
git commit -m "Initial bot implementation"
git push origin main
```

### 3. Traer el código al servidor cPanel

En cPanel → **Git Version Control** → busca el repo `bot-uzed` → clic en **Manage** → pestaña **Pull or Deploy** → **Update from Remote**.

Esto trae los archivos a `/home2/uzedsolutions/bot.uzedsolutions.com/`.

### 4. Configurar variables de entorno

En cPanel → **Setup Node.js App** → editar la app (ícono de lápiz) → sección **Environment variables** → agregar una por una las variables del `.env.example` con los valores reales:

- `ANTHROPIC_API_KEY`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_VERIFY_TOKEN` (inventa un string aleatorio, ej: `uzed-bot-verify-2026`)
- `WHATSAPP_APP_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Clic en **Save**.

### 5. Instalar dependencias

En el mismo panel de Setup Node.js App, clic en **Run NPM Install**. Espera a que termine (toma ~1-2 min).

### 6. Reiniciar la app

Clic en **Restart** para que tome las variables de entorno y el código nuevo.

### 7. Verificar que está corriendo

Abre `https://bot.uzedsolutions.com/` en el navegador. Debería devolver:

```json
{"status":"ok","service":"bot-uzed","time":"..."}
```

### 8. Configurar el webhook en Meta

1. En Meta for Developers → tu app → **WhatsApp → Configuración**
2. En **Webhook**, clic en **Editar**
3. **URL de devolución de llamada**: `https://bot.uzedsolutions.com/webhook`
4. **Token de verificación**: el mismo string que pusiste en `WHATSAPP_VERIFY_TOKEN`
5. Clic en **Verificar y guardar** — si sale OK, el webhook está conectado
6. En **Campos de webhook**, suscríbete a **messages**

### 9. Probar end-to-end

Desde tu WhatsApp personal (el que verificaste en "Para" de la configuración de API), envía un mensaje al número de prueba de Meta:

- "Hola, ¿qué especialidades manejan?"
- "Quiero agendar una cita con el Dr. Juan Pérez"

El bot debería responder de forma natural.

## Actualizar el bot después

Cuando hagas cambios:

1. `git push` desde tu máquina al repo de GitHub
2. En cPanel → **Git Version Control** → **Update from Remote**
3. Si cambiaron dependencias en `package.json`: **Run NPM Install**
4. Clic en **Restart** en la app Node.js

## Logs y debugging

Los logs de Passenger están en `stderr.log` dentro de la carpeta de la app (verlos desde File Manager). Los logs de Fastify salen ahí también.

## Próximos pasos sugeridos

- Agregar Row Level Security (RLS) en Supabase para mayor seguridad
- Persistir conversaciones en Supabase (actualmente viven en memoria del proceso)
- Agregar plantillas de mensajes pre-aprobadas por Meta para recordatorios proactivos
- Implementar rate limiting por número de WhatsApp
- Verificar número de negocio real en Meta para quitar el sandbox

## Cumplimiento

Este bot procesa información potencialmente sensible (datos de pacientes y citas). Antes de producción:

- Agrega aviso de privacidad y consentimiento explícito del paciente
- Revisa regulaciones locales (NOM-024 en México, HIPAA en EE.UU., GDPR en UE)
- Considera cifrado adicional de campos sensibles
- Implementa logs de auditoría para accesos a datos