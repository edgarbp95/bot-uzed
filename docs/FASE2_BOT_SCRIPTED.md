# Fase 2 — Bot scripted (menús) como default para PyMEs

> **Estado:** PLAN A FUTURO. **No implementar ahora.**
> El bot actual con IA (Sonnet 4.5) se mantiene intacto. Este doc es el camino B
> para ofrecer una versión sin costo de LLM por conversación, pensada para el
> tier base de PyMEs, dejando el bot con IA como add-on premium.

---

## 1. Motivación

El bot actual usa Claude Sonnet 4.5 y cuesta aproximadamente:

- Clínica chica (~20 conv/día, 600/mes): **~US$ 90/mes** solo en tokens.
- Clínica mediana (~100 conv/día, 3.000/mes): **~US$ 450/mes**.
- Clínica grande (~500 conv/día, 15.000/mes): **~US$ 2.250/mes**.

Para el target de Uzed Health (PyMEs LATAM) eso es caro: si el plan de Uzed
está entre US$ 30 y US$ 100/mes, el costo del LLM se come el margen o exige
un add-on que no todos los clientes van a pagar.

**Hipótesis:** la mayoría del flujo (agendar / reprogramar / cancelar) no
necesita comprensión de lenguaje natural — un menú con botones y listas cubre
>90% de los casos. Un bot scripted:

- No paga LLM por conversación.
- Es más predecible (0 alucinaciones, 0 desvíos).
- Es más rápido (sin round-trip al modelo).
- Se puede auditar como una máquina de estados.

El costo del lenguaje natural lo pagás cuando realmente aporta (ej. "¿puedo
pagar con tarjeta?", "mi hijo tiene fiebre, ¿vienen mañana?"). Para eso, el
bot con IA queda como **add-on premium** y/o como **fallback** cuando el
paciente escribe algo que no calza con ningún botón.

## 2. Estrategia comercial

| Tier        | Bot WhatsApp              | Costo LLM por conv     |
|-------------|---------------------------|------------------------|
| Base / PyME | Scripted (este doc)       | US$ 0                  |
| Premium     | IA (el actual)            | ~US$ 0.15–0.20 de cost |
| Mixto       | Scripted + IA como fallback (cuando no matchea menú) | Bajo (solo fallback paga LLM) |

El router se decide en `organization_settings.whatsapp_bot_mode`
(`scripted` | `ai` | `hybrid` | `off`).

## 3. Capacidades de WhatsApp Cloud API relevantes

Todo lo que sigue se puede hacer **sin IA**, solo con la API de WhatsApp:

- **Reply buttons**: hasta 3 botones por mensaje. Ideal para Sí/No/Volver.
- **List message**: 1 botón que abre una lista de hasta 10 filas agrupables
  en secciones. Ideal para elegir especialidad, profesional o día.
- **WhatsApp Flows**: mini-formularios nativos dentro del chat. Permiten
  campos text, email, date picker, drop-down, checkbox, etc. Ideal para
  registrar paciente nuevo o elegir fecha precisa.
- **Template messages (utility)**: para confirmaciones post-agendamiento
  fuera de la ventana de 24h.

### Costos de mensajes en LATAM (WhatsApp pricing 2024–2025)

- **Service conversations** (iniciadas por el usuario, ventana de 24h):
  **gratis** en Colombia, Argentina, México.
- **Utility conversations** (iniciadas por el negocio, ej. confirmación de
  cita al día siguiente): ~US$ 0.028 en CO, varía por país. Todas ya pagadas
  por el funcionamiento actual del bot, no se suma costo nuevo.

Conclusión: el bot scripted, respondiendo a mensajes del paciente, **no agrega
costo de WhatsApp** más allá del que ya paga el bot con IA.

## 4. Flujo scripted propuesto

### 4.1 Menú principal (al recibir el primer mensaje sin contexto)

```
Mensaje de texto:
  ¡Hola! Soy el asistente de {nombre_clinica}. ¿En qué te ayudo?

List message (1 lista con 5 filas):
  1. Agendar una cita
  2. Reprogramar una cita
  3. Cancelar una cita
  4. Ver mis citas
  5. Hablar con recepción
```

### 4.2 Rama "Agendar"

**Paso 1 — Elegir especialidad** (si hay más de una)
```
List message:
  Secciones (una por especialidad activa en la clínica):
    - Odontología general → "Consulta", "Limpieza", "Blanqueamiento"
    - Ortodoncia → "Consulta ortodoncia"
    - ...
```
Si la clínica tiene **una sola especialidad**, saltar este paso.

**Paso 2 — Elegir profesional** (si el tipo de cita lo requiere y hay más de uno)
```
List message:
  - Dra. X
  - Dr. Y
  - Cualquiera disponible
```
Si hay un solo profesional habilitado, saltar este paso.

**Paso 3 — Elegir día**

Opción A (recomendada para MVP): **list message con los próximos N días con
horarios disponibles, precomputados desde la DB.**
```
List message:
  - Lun 20 abr (3 horarios)
  - Mar 21 abr (5 horarios)
  - Mié 22 abr (sin disponibilidad)
  - ...
```
Esto se resuelve 100% del lado servidor consultando la grilla: zero código
de parseo de texto, zero ambigüedad.

Opción B (futuro): **WhatsApp Flow con date picker nativo**. Más lindo y
flexible, pero requiere publicar un Flow en Meta Business Manager y
mantener el JSON del Flow. Dejar para una segunda iteración.

Opción C (descartada): texto libre + parser tipo `chrono-node`. Demasiada
fricción para el paciente ("23 de abril", "próximo martes", "23/4") y
demasiadas chances de error.

**Paso 4 — Elegir hora del día**
```
List message:
  - 09:00
  - 09:30
  - 10:00
  - ...
  (solo slots realmente libres, calculados server-side con la lógica
   actual de consultar_horarios_disponibles)
```

**Paso 5 — Identificar al paciente**

Si ya hay un paciente identificado por número de WhatsApp
(`patients.phone = from`):
```
Reply buttons:
  ¿Sos {nombre_paciente}?
  [Sí, soy yo]  [No, otra persona]  [Cancelar]
```

Si no:
```
Opción A: WhatsApp Flow
  Form con nombre, apellido, fecha de nacimiento, ciudad.

Opción B: mensajes secuenciales
  "¿Cuál es tu nombre completo?" → captura
  "¿Fecha de nacimiento? (DD/MM/AAAA)" → captura y valida formato
  "¿Ciudad?" → captura
```
Recomendado Flow: menos fricción, una sola pantalla.

**Paso 6 — Confirmación**
```
Mensaje de texto:
  Revisá tu cita:
  • {tipo} con {profesional}
  • {fecha} a las {hora}
  • Paciente: {nombre}

Reply buttons:
  [Confirmar]  [Cambiar]  [Cancelar]
```

Al confirmar: insert en `appointments`, responde con el template de
confirmación (el mismo que ya usa el bot IA).

### 4.3 Rama "Reprogramar"

1. Buscar citas futuras del paciente (por `phone`) con
   `start_at > now()` y `status != 'cancelled'`.
2. List message con esas citas.
3. Validar regla de las 2 horas (`start_at - now() >= 2h`), si no, cortar
   con mensaje claro.
4. Elegir nuevo día → nueva hora (mismo flujo que agendar, pasos 3 y 4),
   excluyendo la cita actual del chequeo de disponibilidad (ya existe
   `exclude_appointment_id` en `consultar_horarios_disponibles`).
5. Confirmar con botones → UPDATE (el trigger setea `rescheduled_at`).

### 4.4 Rama "Cancelar"

1. Buscar citas futuras como en reprogramar.
2. List message con las citas.
3. Mostrar datos y pedir confirmación explícita:
   ```
   ¿Cancelar {tipo} del {fecha} {hora} con {profesional}?
   [Sí, cancelar]  [No]
   ```
4. UPDATE `status = 'cancelled'`.

### 4.5 Rama "Ver mis citas"

1. SELECT citas futuras del paciente.
2. Mandar un mensaje de texto con la lista (o un list message si hay más de 1).

### 4.6 Rama "Hablar con recepción"

- Marcar la conversación como "escalada" en `whatsapp_conversations`.
- Notificar al staff por el canal que uses (email, push, Slack, panel).
- Dejar de responder con el bot hasta que el staff destrabe.

### 4.7 Fallback (texto que no matchea ningún botón)

Dos caminos posibles:

**A — Solo scripted (tier base):**
```
Mensaje de texto:
  No entendí tu mensaje. Elegí una opción:
  [Mostrar menú]
```

**B — Híbrido (tier premium "hybrid"):**
- Si el paciente escribe algo que no calza con los botones, enrutar al bot
  con IA actual para ese turno.
- Volver al scripted cuando termine ese sub-flujo.
- Esto da lo mejor de los dos mundos: scripted cubre el 90% gratis, el LLM
  solo interviene cuando hace falta.

## 5. Arquitectura y coexistencia con el bot actual

### 5.1 Router de entrada

En `server.js` / `src/handleIncomingMessage.js`:

```js
const orgSettings = await loadOrgSettings(orgId);
const mode = orgSettings.whatsapp_bot_mode ?? 'ai';

switch (mode) {
  case 'off':
    return; // El bot no responde, solo staff.
  case 'scripted':
    return handleScriptedMessage(ctx, message);
  case 'hybrid':
    return handleHybridMessage(ctx, message); // scripted + fallback a IA
  case 'ai':
  default:
    return handleAiMessage(ctx, message); // flujo actual, sin tocar
}
```

El flujo `ai` queda **exactamente como está hoy**. No se toca `agent.js`
ni `tools.js` para esta fase 2.

### 5.2 Cambios de schema

**`organization_settings`** (nueva columna):

```sql
ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS whatsapp_bot_mode text NOT NULL DEFAULT 'ai'
    CHECK (whatsapp_bot_mode IN ('ai', 'scripted', 'hybrid', 'off'));
```

**`whatsapp_conversations`** (nuevas columnas para la máquina de estados scripted):

```sql
ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS scripted_step text,
  ADD COLUMN IF NOT EXISTS scripted_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS scripted_updated_at timestamptz;
```

- `scripted_step`: nombre simbólico del paso actual (`menu`, `agendar.especialidad`,
  `agendar.profesional`, `agendar.dia`, `agendar.hora`, `agendar.paciente`,
  `agendar.confirmacion`, `reprogramar.elegir_cita`, `cancelar.elegir_cita`, etc.).
- `scripted_state`: datos acumulados del flujo (especialidad elegida, profesional
  elegido, día elegido, etc.).
- TTL: si `scripted_updated_at < now() - 1h`, resetear estado al próximo mensaje.

### 5.3 Estructura de código sugerida

```
src/
  scripted/
    index.js              # handleScriptedMessage(ctx, message)
    steps/
      menu.js             # renderer + handler del menú principal
      agendar.js          # sub-máquina de agendar
      reprogramar.js      # sub-máquina de reprogramar
      cancelar.js         # sub-máquina de cancelar
      misCitas.js
      recepcion.js
    messages/
      builders.js         # helpers para construir list/button/text payloads
      templates.js        # strings reutilizables en es-LA
    state.js              # load/save scripted_state
    router.js             # despacha según scripted_step
  hybrid/
    index.js              # handleHybridMessage — intenta scripted primero,
                          # si no matchea cae a agent.js
```

El bot IA actual (`src/agent.js`, `src/tools.js`) no se toca — la fase 2
convive sin dañar nada.

### 5.4 Reutilización de lógica

Las RPCs y queries que ya tiene el bot IA se pueden reusar tal cual:

- `search_patients_by_name` → ya está.
- `consultar_horarios_disponibles` → ya acepta `exclude_appointment_id`.
- Lógica de `reprogramar_cita` y `cancelar_cita` en `tools.js` → extraer a
  módulos de `src/lib/appointments/` y llamar desde scripted e IA por igual.

Esto evita duplicar reglas de negocio (regla de 2h, cálculo de end_at,
ownership del paciente, etc.).

## 6. Rollout sugerido

1. **MVP scripted (mes 1):**
   - Menú + agendar con list messages (opción A de día).
   - Registro de paciente secuencial (sin Flows todavía).
   - Reprogramar y cancelar.
   - Modo `scripted` disponible en `organization_settings`.
   - Bot IA sigue por default.

2. **Pulido (mes 2):**
   - WhatsApp Flow para registro de paciente.
   - WhatsApp Flow con date picker para día/hora.
   - Modo `hybrid` (fallback a IA para texto libre).
   - Panel admin para que el dueño de la clínica elija modo.

3. **Go-to-market (mes 3):**
   - Scripted = default al onboardar una nueva clínica.
   - IA = add-on premium con caps (TANDA C1).
   - Caso de hybrid: cap mensual de mensajes LLM incluidos en el plan.

## 7. Preguntas abiertas

- **Idioma / tono:** ¿los textos los define cada clínica, o son de Uzed con
  placeholders para el nombre? Sugerencia: textos Uzed + placeholder para
  nombre de clínica y profesionales. Simplifica el onboarding.
- **Pacientes menores:** en el flujo scripted, cuando el paciente es menor,
  ¿quién es el titular del chat (el padre/madre) y cómo se liga al menor?
  Replicar la lógica minor-safe de Tanda A.
- **Varios idiomas:** por ahora solo español. Si se abre Brasil, agregar
  portugués como segundo set de strings.
- **Analytics:** loguear `scripted_step` transitions para saber dónde la
  gente abandona el flujo (drop-off por paso).

## 8. Qué NO hace este plan

- No reemplaza al bot IA actual. Se agrega al lado.
- No requiere tocar `agent.js`, `tools.js` ni las migraciones existentes.
- No agrega costo variable por conversación (más allá de lo que ya paga WhatsApp,
  que en LATAM para conversaciones service es US$ 0).
- No cubre casos de lenguaje libre complejo — para eso está el tier premium
  con IA o el modo `hybrid`.

---

**Decisión pendiente del owner (Edgar):** cuándo arrancar Fase 2. Este doc
queda como referencia para esa conversación.
