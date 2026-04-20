# WhatsApp Flows del bot scripted

Carpeta con los JSON de los Flows usados por el bot scripted. Los Flows son
opcionales — si no se publican, el bot cae al flujo secuencial de mensajes.

## `registro_paciente.json`

Formulario estático (sin endpoint ni cifrado) para capturar los datos del
paciente en el flujo de agendamiento. Campos:

- `first_name` (obligatorio)
- `last_name` (obligatorio)
- `birth_date` — date picker nativo, min-date 1900-01-01 (obligatorio)
- `city` (opcional)
- `email` (opcional, con validación de formato en el cliente)

Cuando el paciente toca "Enviar", los datos llegan al webhook normal del
bot como `interactive.type = "nfm_reply"`, y el dispatcher (`src/scripted/steps/agendar.js`)
llama a `registrar_paciente` con esos valores.

### Cómo publicarlo

1. Entrar a **WhatsApp Manager** (business.facebook.com) → **Account Tools** → **Flows**.
2. **Create flow** → nombre "Registro paciente", categoría "Sign up", idioma "Spanish (LA)".
3. En el editor pegar el contenido de `registro_paciente.json`.
4. "Send to phone" para probar (te llega a tu WhatsApp personal).
5. Una vez verificado, click en **Publish**.
6. Copiar el **Flow ID** que te devuelve Meta.

### Activarlo en el bot

Setear en `.env`:

```env
WHATSAPP_USE_FLOW_REGISTRO=true
WHATSAPP_FLOW_REGISTRO_ID=<flow id de Meta>
```

Si cualquiera de las dos variables falta, el bot usa el flujo secuencial
(le pide los datos uno por uno por mensaje). No hace falta cambiar nada más.

### Por qué no requiere aprobación manual

Es un Flow **estático** (sin `data_api_version` ni endpoint). Meta sólo
valida el JSON automáticamente al publicarlo. No pide llaves RSA, no hace
health check, y no va a revisión humana porque:

- No se usa como template de mensaje proactivo (solo responde dentro de la
  ventana de 24h cuando el paciente escribió primero).
- No pide datos médicos sensibles (solo nombre, fecha de nacimiento, ciudad,
  email — lo mismo que cualquier Flow de sign-up comercial).

### Actualizarlo

Si cambiás el JSON, en WhatsApp Manager **Edit flow** → pegar nuevo JSON →
**Publish**. No hace falta cambiar el flow id — se mantiene.
