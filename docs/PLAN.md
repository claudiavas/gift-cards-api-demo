# Plan de Implementación - Integración Amazon y Custodia de Códigos de Tarjetas Regalo

## Contexto
Campaña de marketing donde alumnos reciben tarjeta regalo Amazon después del período de desistimiento (20 días tras matrícula). Los códigos tienen valor real ($) y deben ser invisibles para los 3 desarrolladores que tienen acceso admin en Zoho One. Los datos se guardan en Zoho CRM en módulos: Invoices + Custom "Referidos".

## ¿Por qué no guardar en Zoho CRM o Creator?

### El problema: Acceso admin sin restricciones

Los 3 desarrolladores tienen **Zoho One access (admin total)**. Esto significa que:

- ❌ **Zoho CRM**: Cualquier código guardado ahí — aunque esté encriptado — es accesible por los admins. No hay forma de restringir su acceso.
- ❌ **Creator**: Mismo problema. Es un módulo dentro de Zoho, así que los admins de Zoho también lo controlan.
- ❌ **Vault de Zoho**: No es escalable para miles de registros y tiene el mismo problema de permisos.

### Solución: Sistema completamente separado

El único forma segura es guardar los códigos en un **sistema fuera de Zoho** al que los developers de Zoho One NO tengan acceso:

- **BigQuery en Google Cloud**: Solo el owner (tú) tiene acceso admin
- **Cloud Logging inmutable**: ACME (IT/compliance) audita de forma independiente
- **SendGrid**: Auditoría de tercero para email

Con esta arquitectura:
- ✅ Los códigos nunca están en Zoho
- ✅ Los desarrolladores no pueden acceder a los códigos
- ✅ ACME puede auditar sin pasar por el developer
- ✅ Todo queda registrado e inmutable

## Arquitectura

### Flujo de la campaña

```
INICIO: Alumno se matricula
    ↓
Zoho CRM crea Invoice + actualiza datos en módulo Referidos
    ↓
    [Pasa 20 días - Período de desistimiento]
    ↓
Zoho CRM Scheduler detecta: 20+ días sin gift card
    ↓
Zoho Deluge llama: POST /gift-cards/process
    ├─ referidoID
    ├─ contactID
    ├─ contactEmail
    └─ contactName
    ↓
════════════════════════════════════════════════════════════════
║ API Node.js (Google Cloud - ZONA SEGURA)
║
║  ⚠️  VALIDACIONES PREVIAS:
║  1. Consulta Zoho: ¿Contacto tiene Invoice en estado "matriculado"?
║  2. Consulta Zoho: ¿Referido tiene Invoice con referencia del Contacto en estado "matriculado"?
║  3. Consulta Zoho: ¿Han pasado más de 20 días desde matrícula?
║
║  ❌ SI FALLA CUALQUIER VALIDACIÓN:
║     └─ Email_Status = "Envío no cumple requisitos"
║     └─ NO genera código Amazon
║     └─ NO envía email
║     └─ Registra en access_logs: "validation_failed"
║     └─ Retorna error a Zoho
║
║  ✅ SI CUMPLEN TODAS LAS VALIDACIONES:
║     1. Recibe llamada de Zoho
║     2. Llama Amazon API → obtiene código nuevo
║     3. Encripta código AES-256 INMEDIATAMENTE
║     4. Guarda en BigQuery tabla gift_cards (encriptado)
║     5. Registra acceso en BigQuery tabla access_logs
║     6. Envía email vía SendGrid (código desencriptado)
║     7. Retorna {success: true, sendgridMessageId} a Zoho
║
════════════════════════════════════════════════════════════════
    ↓
Zoho CRM actualiza Referidos:
    ├─ Gift_Card_Enviada = true
    ├─ Gift_Card_Enviada_Fecha = [timestamp]
    ├─ Gift_Card_SendGrid_ID = [msg_id]
    └─ Gift_Card_Email_Status = "Correo Enviado"
    ↓
Alumno recibe email con código (vía SendGrid)
    ↓
Alumno canjea código en Amazon
    ↓
FIN: Código utilizado
```

### Arquitectura de seguridad

```
┌─────────────────────────────────────┐
│  ZONA PÚBLICA (Todos ven)           │
│                                     │
│  Zoho CRM - Módulo Referidos       │
│  • Gift_Card_Enviada: true/false    │
│  • Gift_Card_Enviada_Fecha          │
│  • Gift_Card_Email_Status           │
│  • Gift_Card_Reenvios               │
│  ❌ NUNCA el código                 │
└─────────────────────────────────────┘
            ↑         ↓
   Deluge   │         │ actualiza
            │         │
            ↓         ↑
┌─────────────────────────────────────┐
│  ZONA SEGURA (Solo owner)           │
│  Google Cloud                       │
│                                     │
│  API Node.js                        │
│  ↓                                  │
│  BigQuery                           │
│  ├─ Tabla: gift_cards               │
│  │  └─ amazon_code_encrypted        │
│  │  └─ contact_email                │
│  │  └─ sendgrid_message_id          │
│  │                                  │
│  └─ Tabla: access_logs              │
│     └─ quién accedió al código      │
│     └─ desde qué IP                 │
│     └─ cuándo                       │
│                                     │
│  Cloud Logging (INMUTABLE)          │
│  └─ Rol "Gift Cards Auditor"        │
│     └─ ACME (auditor)          │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  TERCEROS (Independientes)          │
│                                     │
│  SendGrid                           │
│  ├─ Email enviado                   │
│  ├─ IP de apertura                  │
│  ├─ Timestamp de apertura           │
│  └─ Dispositivo                     │
│                                     │
│  Amazon                             │
│  ├─ IP de canje                     │
│  ├─ Timestamp de canje              │
│  └─ Orden ID                        │
└─────────────────────────────────────┘
```

## Componentes

### 1. API Node.js (Google Cloud Run)

**Endpoints:**
- `POST /gift-cards/process` — Recibe referidoID y contactID. Si referidoID ya fue procesado: reenvía email. Si es nuevo: hace validaciones, llama Amazon, guarda, envía.
- `GET /health` — Health check

**Autenticación Amazon Incentives API:**
- **AWS Signature Version 4** (no API Key simple)
- Credentials: `partnerId`, `agcodAccessKey`, `agcodSecretKey`
- Headers requeridos:
  - `x-amz-date`: ISO 8601 (YYYYMMDDTHHMMSSZ)
  - `x-amz-target`: `com.amazonaws.agcod.AGCODService.CreateGiftCard`
  - `Authorization`: Firma AWS Sig V4
  - `content-type`: application/x-amz-json-1.1
- **Timestamp debe estar dentro de 15 minutos** del servidor Amazon

**Lógica del endpoint POST /gift-cards/process:**

El endpoint recibe: `referidoId`, `contactId`, `contactEmail`, `contactName`

**Paso 1: Verificar si el referido ya fue procesado**
```
SELECT * FROM gift_cards WHERE referido_id = {referidoId}
```

- **SI el registro existe** → REENVÍO (no llama a Amazon)
  1. Obtener `amazon_code_encrypted` de la tabla
  2. Registrar en `access_logs`: `action="resent"`, `performed_by="scheduler"`
  3. Desencriptar código AES-256 (solo en memoria)
  4. Enviar email vía SendGrid con el mismo código
  5. Registrar nuevo `sendgrid_message_id` en gift_cards
  6. Retornar: `{success: true, status: "resent", sendgridMessageId: "nuevo-msg-id"}`

- **SI el registro NO existe** → NUEVO (llama a Amazon)
  1. Proceder con validación en Zoho CRM (ver abajo)
  2. **Verificar fondos disponibles** en Amazon (GetAvailableFunds)
  3. Generar `creationRequestId` único (UUID v4)
  4. Llamar Amazon CreateGiftCard API con:
     - `partnerId` (de credenciales)
     - `currencyCode` (USD, EUR, JPY, CAD, AUD, TRY, AED)
     - `amount` (valor en unidades menores: 5000 = $50.00)
     - `creationRequestId` (para idempotencia)
  5. Amazon retorna: `gcClaimCode` (código de 16 caracteres aprox)
  6. Encriptar AES-256
  7. Guardar en gift_cards con `referido_id` ÚNICO + `creation_request_id`
  8. Registrar en access_logs: `action="generated"`
  9. Enviar email vía SendGrid
  10. Retornar: `{success: true, status: "generated", sendgridMessageId}`

**Validación previa a generación de código (solo si es NUEVO):**

Antes de llamar a Amazon, validar:

1. **Query Zoho CRM**: ¿El contacto original (quien recibe la tarjeta) tiene al menos un Invoice en estado "matriculado"?
   ```
   GET /crm/v3/modules/Invoices?criteria=(contact_id={contactId} AND status:equals:matriculado)
   ```
   - Si NO → Validación falla

2. **Query Zoho CRM**: Obtener datos del Referido y extraer el contactId del referido
   ```
   GET /crm/v3/modules/Referidos/{referidoId}
   → Extraer el contactId del referido de este registro [CAMPO A CONFIRMAR CON ZOHO]
   ```

3. **Query Zoho CRM**: ¿El contacto referido (el que fue referenciado) tiene un Invoice en estado "matriculado" con fecha de matrícula > 20 días?
   ```
   GET /crm/v3/modules/Invoices?criteria=(contact_id={referidoContactId} AND status:equals:matriculado AND fecha_matrícula < TODAY()-20)
   ```
   - Si NO → Validación falla
   - Si el Invoice existe pero fue creado hace <20 días → Validación falla

3. **Acción si FALLA validación:**
   - NO generar código Amazon
   - NO encriptar
   - NO guardar en BigQuery
   - Registrar en access_logs: `action="validation_failed"` con detalles del motivo
   - Retornar a Zoho: `{success: false, reason: "validation_failed", detail: "Contacto no matriculado" | "Referido no matriculado" | "Referido matrícula <20 días"}`
   - Zoho actualiza campo `Gift_Card_Email_Status = "Envío no cumple requisitos"`

4. **Acción si CUMPLEN todas las validaciones:**
   - Proceder normalmente: generar código, encriptar, enviar email

**Manejo de errores de Amazon Incentives API:**

| Error | Código | Acción | Ticket CRM |
|---|---|---|---|
| Éxito | (sin error) | Guardar código, registrar `action="generated"` | No |
| Sistema no disponible | F400 | **Reintentar automáticamente** (max 3 intentos con backoff exponencial) | No (se reintenta automáticamente) |
| Error interno Amazon | F100 | Registrar `action="amazon_error"`, NO reintentar | **SÍ** - Email a crm@acme-example.com |
| Request inválido | F200 | Registrar error, revisar firma AWS Sig V4 | **SÍ** - Email a crm@acme-example.com |
| Fondos insuficientes | F300 | Registrar error, NO reintentar | **SÍ** - Email a crm@acme-example.com |
| Contrato no válido | F300 | Registrar error, NO reintentar | **SÍ** - Email a crm@acme-example.com |
| Throttled (rate limit) | Throttled | Ralentizar y **reintentar** después de 1-2 segundos | No (se reintenta automáticamente) |
| Error desconocido | F500 | Registrar, contactar Amazon | **SÍ** - Email a crm@acme-example.com |

**Importante:** Usar `creationRequestId` para idempotencia — si reintentos de F400 fallan y luego Amazon responde con éxito, no generar código duplicado.

**Formato de emails de error a crm@acme-example.com:**

**F100 - Error interno Amazon:**
- Asunto: `[CRÍTICO] Error interno Amazon Incentives API - F100`
- Cuerpo: referido_id, contact_id, error message, timestamp, acción recomendada: "Contactar a Amazon"

**F200 - Request inválido:**
- Asunto: `[ERROR] Request inválido en Amazon API - F200`
- Cuerpo: referido_id, contact_id, detalle del error, valor de AWS Sig V4, timestamp, acción: "Revisar configuración AWS Signature V4"

**F300 - Fondos insuficientes:**
- Asunto: `[ALERTA] Fondos insuficientes en Amazon Incentives API`
- Cuerpo: referido_id, contact_id, monto solicitado, saldo disponible, timestamp, acción: "Recargar fondos en Amazon Seller Central"

**F300 - Contrato no válido:**
- Asunto: `[ALERTA] Contrato no válido en Amazon Incentives API`
- Cuerpo: referido_id, contact_id, error message, timestamp, acción: "Revisar contrato con Amazon"

**F500 - Error desconocido:**
- Asunto: `[CRÍTICO] Error desconocido en Amazon API - F500 (posible outage)`
- Cuerpo: referido_id, contact_id, full error response, timestamp, acción: "Contactar a Amazon y revisar status"

**Seguridad:**
- API Key en header (solo Zoho conoce la key)
- AES-256 para encriptar códigos en BD
- HTTPS obligatorio
- Variables de entorno para credenciales (nunca en código)
- Código Amazon se encripta **inmediatamente** al recibirlo, antes de cualquier otra operación
- Nunca se loguea el código en ningún punto
- Logs de la plataforma (GCP) protegidos: solo el owner tiene acceso
- En reenvíos: Node ignora el email que venga de Zoho, usa siempre el email original guardado en BigQuery (tabla gift_cards)

**Stack:**
- Node.js + Express
- `crypto` (nativo) para encriptación AES-256
- **SendGrid** para envío de emails y auditoría
- **BigQuery** (Google Cloud) — equipo BigData de ACME

---

### Idempotencia con `creationRequestId` (Prevención de códigos duplicados)

**El problema:**

Cuando reintentas una solicitud a Amazon (ej: por F400 - timeout), existe el riesgo de generar códigos duplicados:

```
Intento 1: POST CreateGiftCard → Timeout (Amazon creó el código pero no respondió)
Intento 2: POST CreateGiftCard → Timeout
Intento 3: POST CreateGiftCard → Éxito: código devuelto
        ↓
Pero: ¿Los intentos 1 y 2 crearon códigos ANTES del timeout?
Result: 3 códigos válidos generados, solo 1 registrado en tu BD
```

**La solución: `creationRequestId`**

Amazon Incentives API soporta un campo `creationRequestId` que es un UUID único que TÚ generas y envías:

```javascript
// Node.js - Generar UUID ANTES de cualquier reintento
const creationRequestId = uuid.v4();  
// Ejemplo: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"

// Intento 1
POST /CreateGiftCard {
  partnerId: "xxx",
  amount: 5000,
  creationRequestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
// Timeout

// Intento 2 (mismo UUID)
POST /CreateGiftCard {
  partnerId: "xxx",
  amount: 5000,
  creationRequestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"  // ← MISMO
}
// Timeout

// Intento 3 (mismo UUID)
POST /CreateGiftCard {
  partnerId: "xxx",
  amount: 5000,
  creationRequestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"  // ← MISMO
}
// Respuesta: "Ya existe un código con este creationRequestId"
// Retorna: { gcClaimCode: "ABCD-EFGH-IJKL-MNOP" }  (el del intento 1)
```

**Cómo funciona:**
1. Amazon **recuerda el UUID** que envías
2. Si recibes el MISMO UUID múltiples veces, Amazon devuelve el **mismo código** (sin duplicar)
3. Si recibes un UUID **diferente**, Amazon genera un código **nuevo**

**Implementación en Node.js:**

```javascript
// src/services/amazonGiftCard.js
const { v4: uuid } = require('uuid');
const crypto = require('crypto');

async function generateGiftCard(referidoId, amount, currencyCode) {
  // Paso 1: Generar creationRequestId ANTES de reintentos
  const creationRequestId = uuid();
  
  // Paso 2: Guardar en variable para reutilizar en reintentos
  let lastError = null;
  const maxAttempts = 3;
  const backoffMs = [100, 200, 400];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Paso 3: Enviar SIEMPRE el MISMO creationRequestId
      const response = await callAmazonAPI({
        partnerId: process.env.AMAZON_PARTNER_ID,
        amount: amount,
        currencyCode: currencyCode,
        creationRequestId: creationRequestId  // ← MISMO en todos los intentos
      });

      // Paso 4: Si éxito, retornar código + creationRequestId
      return {
        gcClaimCode: response.gcClaimCode,
        creationRequestId: creationRequestId
      };
    } catch (error) {
      lastError = error;
      
      // Solo reintentar en F400
      if (error.code !== 'F400') {
        throw error;
      }

      // Esperar antes del siguiente intento
      if (attempt < maxAttempts - 1) {
        await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]));
      }
    }
  }

  throw lastError;
}
```

**Guardando en BigQuery (prevención de duplicados):**

```javascript
// BigQuery rechazará si intentas insertar 2 registros con el mismo creationRequestId
await bigquery.table('gift_cards').insert({
  referido_id: referidoId,
  contact_email: email,
  amazon_code_encrypted: encrypt(giftCard.gcClaimCode),
  amazon_creation_request_id: giftCard.creationRequestId,  // ← ÚNICO
  amazon_currency_code: currencyCode,
  amazon_amount: amount,
  created_at: new Date()
});
// Si ya existe un row con amazon_creation_request_id = "a1b2c3d4..."
// → BigQuery RECHAZA la inserción (UNIQUE constraint)
```

**Tabla BigQuery con constraint:**

```sql
CREATE TABLE gift_cards (
  id UUID PRIMARY KEY,
  referido_id VARCHAR(255) NOT NULL UNIQUE,
  amazon_code_encrypted TEXT NOT NULL,
  amazon_creation_request_id VARCHAR(255) UNIQUE,  -- ← EVITA DUPLICADOS
  ...
);
```

**En resumen:**
- ✅ Un UUID por solicitud (no por intento)
- ✅ MISMO UUID en todos los reintentos
- ✅ Amazon devuelve el mismo código si recibe el mismo UUID
- ✅ BigQuery rechaza duplicados gracias al constraint UNIQUE

---

### 2. BD: Tablas BigQuery

**Tabla `gift_cards`:**
```sql
CREATE TABLE gift_cards (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referido_id             VARCHAR(255) NOT NULL UNIQUE,  -- ID del módulo Referidos en Zoho (ÚNICO: un código por referido)
  contact_email           VARCHAR(255) NOT NULL,  -- Email original, inmutable
  amazon_code_encrypted   TEXT NOT NULL,          -- AES-256, nunca sale desencriptado salvo para envío
  amazon_creation_request_id VARCHAR(255) UNIQUE, -- creationRequestId único para idempotencia (Amazon)
  amazon_currency_code    VARCHAR(3),             -- USD, EUR, JPY, CAD, AUD, TRY, AED
  amazon_amount           INT,                    -- Monto en unidades menores (5000 = $50.00)
  amazon_redeemed_at      TIMESTAMP,              -- Se rellena manualmente consultando Amazon Dashboard (NO es automático)
  amazon_redeemed_ip      VARCHAR(45),            -- Metadata manual o si Amazon lo proporciona en futuros reports
  sendgrid_message_id     VARCHAR(255),           -- Para cruzar con logs de SendGrid (actualizado en reenvíos)
  email_sent              BOOLEAN DEFAULT FALSE,
  email_sent_at           TIMESTAMP,
  email_resent_count      INT DEFAULT 0,          -- Contador de reenvíos
  email_last_resent_at    TIMESTAMP,              -- Timestamp del último reenvío
  email_status            VARCHAR(50),            -- sent / resent / bounced / opened / etc
  bounce_reason_es        VARCHAR(255),           -- Motivo de rechazo EN ESPAÑOL (para agentes CRM)
  email_template          VARCHAR(255),
  created_at              TIMESTAMP DEFAULT NOW(),
  updated_at              TIMESTAMP DEFAULT NOW() ON UPDATE CURRENT_TIMESTAMP
);
```

**Motivos de rechazo (SendGrid → Español):**
| SendGrid | Español |
|---|---|
| Invalid email address | Email inválido |
| Mailbox full | Buzón lleno |
| User unknown | Usuario desconocido |
| Domain not found | Dominio no encontrado |
| Domain inactive | Dominio inactivo |
| Recipient rejected | Destinatario rechazado |
| Spam complaint | Queja de spam |
| Unsubscribe | Desuscrito |
| Invalid SMTP response | Error del servidor de email |
| Bounce | Rechazo general |

**Tabla `access_logs` (auditoría de accesos a códigos):**
```sql
CREATE TABLE access_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gift_card_id      UUID REFERENCES gift_cards(id),
  action            VARCHAR(50),    -- 'validation_failed', 'amazon_error', 'generated', 'sent', 'resent', 'decrypted'
  performed_by      VARCHAR(255),   -- 'scheduler', 'agent@empresa.com', 'system'
  source_ip         VARCHAR(45),    -- IP desde donde se hizo la acción
  failure_reason    VARCHAR(255),   -- Motivo de fallo (ej: "contact_invoice_not_found")
  amazon_error_code VARCHAR(10),    -- Si action='amazon_error': F100, F200, F300, F400, F500, Throttled
  amazon_error_msg  VARCHAR(500),   -- Mensaje de error de Amazon
  created_at        TIMESTAMP DEFAULT NOW()
);
```

Así cualquier acceso al código queda registrado. En caso de disputa: **nadie de la empresa accedió al código sin dejar rastro.**

---

### 3. Cloud Storage: Estrategia de Backup

**¿Por qué hacer backups?**

Los datos de `gift_cards` y `access_logs` tienen valor crítico:
- 💰 Dinero real (tarjetas Amazon)
- 📋 Auditoría legal (quién accedió a qué)
- ⚖️ Cumplimiento normativo

Un backup fallido = pérdida total de datos.

**Estrategia:**

```
BigQuery (Producción)
    ↓ Cada noche 2 AM UTC
Cloud Storage (Backup automático)
├─ Últimos 30 días: Standard (acceso rápido)
├─ Más de 30 días: Coldline (archival económico)
└─ Retención: 1 año mínimo
    ↓ Encriptado con Google-managed keys
```

**¿Qué se respalda?**
- `gift_cards` tabla completa (incluida encriptada)
- `access_logs` tabla completa (auditoría)
- Formato: Parquet (comprimido, eficiente)

**Estructura de Cloud Storage:**

```
gs://acme-gift-cards-backups/
├── gift_cards/
│   ├── 2026-05-21/gift_cards_2026-05-21_*.parquet
│   ├── 2026-05-22/gift_cards_2026-05-22_*.parquet
│   └── ...
├── access_logs/
│   ├── 2026-05-21/access_logs_2026-05-21_*.parquet
│   ├── 2026-05-22/access_logs_2026-05-22_*.parquet
│   └── ...
└── metadata/
    └── backup_manifest.json (cuándo se hizo, tamaño, checksum)
```

**Encriptación:**
- Google-managed keys (suficiente, Google es responsable)
- Opcional: Customer-managed keys en Google Cloud KMS (más control, más caro)

**Acceso IAM para backups:**

| Rol | Permisos | Acceso |
|---|---|---|
| **Owner** | Full control | Lectura/escritura/eliminación de backups |
| **ACME (IT)** | Read-only | Lectura de backups para auditoría |
| **Developers** | ❌ NINGUNO | Sin acceso a Cloud Storage |

---

### Opciones de ejecución del Backup

**Para automatizar la exportación BigQuery → Cloud Storage:

#### Opción 1: Cloud Scheduler + Cloud Function

**Ventajas:**
- ✅ Automático, sin mantenimiento
- ✅ Barato (~$0.40/mes)
- ✅ Confiable (Google lo ejecuta)
- ✅ Logs en Cloud Logging
- ✅ No depende de Zoho

**Configuración:**

```yaml
# Cloud Scheduler Job
Name: "gift-cards-backup"
Frequency: "0 2 * * *"  (Cada noche 2 AM UTC)
Timezone: UTC
Auth: Service Account (con permisos BigQuery + Cloud Storage)
Ejecuta: Cloud Function "exportGiftCardsBackup"
```

**Cloud Function (Node.js):**

```javascript
// functions/exportGiftCardsBackup/index.js
const { BigQuery } = require('@google-cloud/bigquery');
const { Storage } = require('@google-cloud/storage');
const dayjs = require('dayjs');

const bigquery = new BigQuery();
const storage = new Storage();

exports.exportGiftCardsBackup = async (req, res) => {
  try {
    const today = dayjs().format('YYYY-MM-DD');
    const bucket = storage.bucket('acme-gift-cards-backups');

    // Exportar gift_cards
    const giftCardsDataset = bigquery.dataset('gift_cards_db');
    const giftCardsTable = giftCardsDataset.table('gift_cards');
    
    const giftCardsDestination = bucket.file(`gift_cards/${today}/gift_cards_${today}_*.parquet`);
    
    await giftCardsTable.extract(giftCardsDestination, {
      format: 'PARQUET',
      compression: 'SNAPPY'
    });

    // Exportar access_logs
    const accessLogsTable = giftCardsDataset.table('access_logs');
    const accessLogsDestination = bucket.file(`access_logs/${today}/access_logs_${today}_*.parquet`);
    
    await accessLogsTable.extract(accessLogsDestination, {
      format: 'PARQUET',
      compression: 'SNAPPY'
    });

    // Registrar en Cloud Logging
    console.log(`✅ Backup completado: ${today}`);
    console.log(`   - gift_cards: ${giftCardsDestination.name}`);
    console.log(`   - access_logs: ${accessLogsDestination.name}`);

    res.status(200).json({
      success: true,
      backup_date: today,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error en backup:', error);
    
    // Enviar email de alerta
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'SendGrid',
      auth: { user: 'apikey', pass: process.env.SENDGRID_API_KEY }
    });
    
    await transporter.sendMail({
      from: 'backups@acme-example.com',
      to: 'crm@acme-example.com',
      subject: '[CRÍTICO] Backup de Gift Cards falló',
      text: `Error: ${error.message}\nTimestamp: ${new Date().toISOString()}`
    });

    res.status(500).json({ error: 'Backup failed', details: error.message });
  }
};
```

**package.json (Cloud Function):**
```json
{
  "name": "gift-cards-backup",
  "version": "1.0.0",
  "dependencies": {
    "@google-cloud/bigquery": "^7.0.0",
    "@google-cloud/storage": "^7.0.0",
    "dayjs": "^1.11.0",
    "nodemailer": "^6.9.0"
  }
}
``
---

### 3. Sanitizer: Prevenir que datos sensibles lleguen a los logs

**¿Por qué?**
Aunque tengamos Cloud Logging inmutable, no queremos que códigos/credentials terminen en NINGÚN log. El sanitizer es la primera línea de defensa.

**¿Qué sanitiza?**
```javascript
// Parámetros sensibles a remover automáticamente de logs:
- Códigos de tarjeta regalo: ABCD-EFGH-IJKL-MNOP → [REDACTED]
- AWS Access Keys: AKIA... → [REDACTED]
- AWS Secret Keys: aws_secret_access_key → [REDACTED]
- API Keys: key_sk_... → [REDACTED]
- Authorization headers: Bearer token → [REDACTED]
- SendGrid keys: SG.xxx → [REDACTED]
```

**Implementación:**

```javascript
// src/middleware/sanitizer.js
const SENSITIVE_PATTERNS = {
  giftCode: /\b[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}\b/g,
  awsAccessKey: /AKIA[0-9A-Z]{16}/g,
  awsSecretKey: /aws_secret_access_key["\s]*[:=]["\s]*[A-Za-z0-9/+=]{40}/g,
  apiKey: /"api[_-]key"["\s]*[:=]["\s]*"[^"]+"/gi,
  authorization: /authorization["\s]*[:=]["\s]*"[^"]+"/gi,
  sendgridKey: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g
};

function sanitize(str) {
  if (typeof str !== 'string') return str;
  
  let sanitized = str;
  Object.values(SENSITIVE_PATTERNS).forEach(pattern => {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  });
  return sanitized;
}

module.exports = { sanitize };
```

**Dónde se aplica:**

```javascript
// src/utils/logger.js
const { sanitize } = require('../middleware/sanitizer');

module.exports = {
  info(message, data) {
    const safe = sanitize(JSON.stringify(data));
    console.log(`[INFO] ${message}: ${safe}`);
  },
  
  error(message, error) {
    const safe = sanitize(error.message || error.toString());
    console.error(`[ERROR] ${message}: ${safe}`);
  },
  
  debug(message, data) {
    // En producción: no loguear
    if (process.env.NODE_ENV === 'development') {
      const safe = sanitize(JSON.stringify(data));
      console.debug(`[DEBUG] ${message}: ${safe}`);
    }
  }
};
```

```javascript
// src/middleware/requestLogger.js
const { sanitize } = require('../middleware/sanitizer');
const logger = require('../utils/logger');

module.exports = (req, res, next) => {
  const body = sanitize(JSON.stringify(req.body));
  logger.info(`${req.method} ${req.path}`, { body });
  next();
};
```

```javascript
// src/middleware/errorHandler.js
const { sanitize } = require('../middleware/sanitizer');
const logger = require('../utils/logger');

module.exports = (error, req, res, next) => {
  const safe = sanitize(error.message);
  logger.error('Unhandled error', new Error(safe));
  
  // NUNCA retornar error.message en response (podría tener datos sensibles)
  res.status(500).json({
    error: 'Internal server error'
  });
};
```

**Tests para sanitizer:**

```javascript
// tests/unit/middleware/sanitizer.test.js
describe('Sanitizer', () => {
  it('should remove gift codes from logs', () => {
    const log = 'Code sent: ABCD-EFGH-IJKL-MNOP to user';
    expect(sanitize(log)).toBe('Code sent: [REDACTED] to user');
  });
  
  it('should remove AWS keys from logs', () => {
    const log = 'Error with key AKIA1234567890ABCDEF';
    expect(sanitize(log)).toBe('Error with key [REDACTED]');
  });
  
  it('should remove SendGrid keys', () => {
    const log = 'SendGrid API: SG.xxx.yyy.zzz';
    expect(sanitize(log)).toBe('SendGrid API: [REDACTED]');
  });
  
  it('should handle multiple sensitive values', () => {
    const log = 'Code ABC-DEF-GHI-JKL with key AKIA123';
    expect(sanitize(log)).toBe('Code [REDACTED] with key [REDACTED]');
  });
  
  it('should not break when no sensitive data', () => {
    const log = 'Normal log message';
    expect(sanitize(log)).toBe('Normal log message');
  });
});
```

**Garantía:**
- ✅ Cloud Logging está protegido por IAM (solo ACME puede verlo)
- ✅ Sanitizer asegura que códigos sensibles NO llegan a logs
- ✅ Incluso si alguien accede a logs, ve [REDACTED]

### 4. Manejo del código desencriptado en memoria

**Flujo CRÍTICO de encriptación/desencriptación:**

```javascript
// ❌ NUNCA HACER ESTO - El código queda en log
const amazonCode = response.code;  // ← Código en texto plano en la aplicación
console.log(`Código generado: ${amazonCode}`);  // ← PELIGRO: quedó en log
logger.info(`Enviando código a ${email}`);

// ✅ HACER ESTO - El código NUNCA toca ningún log
// Paso 1: Recibir código de Amazon
const amazonCodeRaw = response.code;

// Paso 2: Encriptar INMEDIATAMENTE (sin loguearlo)
const amazonCodeEncrypted = crypto.encrypt(amazonCodeRaw);

// Paso 3: Guardar encriptado en BigQuery (no el código original)
await bigquery.table('gift_cards').insert({
  referido_id: referidoId,
  amazon_code_encrypted: amazonCodeEncrypted,  // ← Guardado ENCRIPTADO
  // ... otros campos ...
});

// Paso 4: Registrar en access_logs QUE SE GENERÓ (sin el código)
await bigquery.table('access_logs').insert({
  gift_card_id: giftCardId,
  action: 'generated',  // ← Solo se loguea la ACCIÓN
  performed_by: 'scheduler',
  source_ip: serverIp
  // ← NO incluir el código aquí
});

// Paso 5: Desencriptar SOLO EN MEMORIA para enviar
const amazonCodePlain = crypto.decrypt(amazonCodeEncrypted);

// Paso 6: Enviar a SendGrid (pasa el código)
await sendgrid.send({
  templateId: 'd-xxxxxxxxxxxxxxxx',
  to: contactEmail,
  dynamicTemplateData: {
    nombre: contactName,
    amazonCode: amazonCodePlain   // ← Solo en memoria, nunca logueado
  }
});

// Paso 7: INMEDIATAMENTE eliminar variable de memoria
amazonCodePlain = null;
amazonCodeRaw = null;  // Si aún existe
delete process.env.TEMP_CODE;  // Por si acaso se guardó en env

// Paso 8: Actualizar BigQuery con sendgrid_message_id (no el código)
await bigquery.table('gift_cards').update({
  id: giftCardId,
  sendgrid_message_id: response.messageId  // ← Solo el ID, no el código
});
```

**QUÉ se loguea en Cloud Logging (Node.js logs):**
```
[2026-06-10 09:00:01] ACTION=generated GIFT_CARD_ID=uuid-123 CONTACT_ID=contact-456
[2026-06-10 09:00:02] ACTION=sent GIFT_CARD_ID=uuid-123 SENDGRID_MSG_ID=msg-789
[2026-06-10 09:00:03] ACTION=email_delivered GIFT_CARD_ID=uuid-123
```
❌ El código NUNCA aparece en estos logs

**QUÉ se loguea en BigQuery:**
```
gift_cards.amazon_code_encrypted = "aes-256-encrypted-base64..."  // ← ENCRIPTADO
gift_cards.sendgrid_message_id = "msg-789"                        // ← Solo ID
access_logs.action = "generated"                                  // ← Solo la acción
```
❌ El código NUNCA en texto plano

**QUÉ sabe SendGrid (tercero independiente):**
- Que recibió un email para enviar
- Que lo envió correctamente
- Que fue abierto desde IP X
- Que se hizo click en link Y
✅ SendGrid VE el código (porque lo necesita para enviarlo), pero es un tercero certificado SOC 2

---

### 4. SendGrid (Emails + Auditoría independiente)

**Por qué SendGrid:**
- Plantillas visuales diseñadas por marketing (sin código)
- Node pasa solo variables dinámicas (`nombre`, `amazonCode`)
- Auditoría nativa generada por **tercero independiente** (más valor probatorio que logs propios)
- Empresa certificada SOC 2 Type II
- SendGrid VE el código (lo necesita para enviar) pero no lo loguea en forma accesible a terceros

**Datos de auditoría de SendGrid:**
- Timestamp de envío
- Timestamp de apertura
- IP de apertura
- Dispositivo y cliente de email
- Geolocalización
- Clicks en links

### 5. AWS Signature Version 4 (Autenticación Amazon Incentives API)

**¿Qué es?**
Mecanismo de firma digital de AWS que valida que el request:
1. Viene de una credencial autenticada (no está falsificado)
2. No ha sido modificado en tránsito
3. No está expirado (timestamp debe estar dentro de ±15 minutos)

**Flujo de firma:**

```
Request data (método, ruta, headers, body)
    ↓
Crear "canonical request" (formato específico de AWS)
    ↓
Hash SHA-256 del canonical request
    ↓
Crear "string to sign" con credenciales + timestamp + región
    ↓
HMAC-SHA256 con AWS Secret Key
    ↓
Header Authorization = "AWS4-HMAC-SHA256 Credential=... SignedHeaders=... Signature=..."
```

**Headers requeridos:**

```
POST /CreateGiftCard HTTP/1.1
Host: agcod-v2.amazon.com
X-Amz-Date: 20260521T093000Z                           ← Timestamp ISO 8601
X-Amz-Target: com.amazonaws.agcod.AGCODService.CreateGiftCard
Content-Type: application/x-amz-json-1.1
Authorization: AWS4-HMAC-SHA256 
  Credential=AKIAIOSFODNN7EXAMPLE/20260521/us-east-1/AGCODService/aws4_request,
  SignedHeaders=host;x-amz-date;x-amz-target,
  Signature=fe5f80f77d5fa3beca038a248ff8dcf0c51cce7d8d61f7b3fead5c9147f7c5a1
```

**Implementación en Node.js:**

Opción 1: Usar librería `aws4` (recomendado):
```javascript
const AWS4 = require('aws4');

const request = {
  host: 'agcod-v2.amazon.com',
  method: 'POST',
  path: '/',  // Amazon Incentives API usa path /
  headers: {
    'X-Amz-Target': 'com.amazonaws.agcod.AGCODService.CreateGiftCard',
    'Content-Type': 'application/x-amz-json-1.1'
  },
  body: JSON.stringify({
    partnerId: 'tu_partner_id',
    currencyCode: 'USD',
    amount: 5000,
    creationRequestId: uuid()
  })
};

// Firmar request
AWS4.sign(request, {
  accessKeyId: process.env.AMAZON_ACCESS_KEY,
  secretAccessKey: process.env.AMAZON_SECRET_KEY
});

// Headers después de firmar incluyen:
// x-amz-date, Authorization
console.log(request.headers.Authorization);
```

Opción 2: Implementación manual (más control, más complejidad):
```javascript
const crypto = require('crypto');

function signRequest(method, host, path, headers, payload) {
  // Paso 1: Preparar timestamp
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, '').split('.')[0] + 'Z';
  const dateStamp = amzDate.substring(0, 8);
  
  // Paso 2: Crear canonical request
  const payloadHash = crypto
    .createHash('sha256')
    .update(payload)
    .digest('hex');
  
  const canonicalHeaders = 
    `host:${host}\nx-amz-date:${amzDate}\nx-amz-target:${headers['X-Amz-Target']}\n`;
  
  const signedHeaders = 'host;x-amz-date;x-amz-target';
  
  const canonicalRequest = [
    method,
    path,
    '',  // query string (vacío)
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  // Paso 3: Hash del canonical request
  const canonicalHash = crypto
    .createHash('sha256')
    .update(canonicalRequest)
    .digest('hex');
  
  // Paso 4: Crear string to sign
  const credentialScope = `${dateStamp}/us-east-1/AGCODService/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalHash
  ].join('\n');
  
  // Paso 5: Calcular signature
  const kSecret = `AWS4${process.env.AMAZON_SECRET_KEY}`;
  const kDate = crypto.createHmac('sha256', kSecret)
    .update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate)
    .update('us-east-1').digest();
  const kService = crypto.createHmac('sha256', kRegion)
    .update('AGCODService').digest();
  const signature = crypto.createHmac('sha256', kService)
    .update(stringToSign)
    .digest('hex');
  
  // Paso 6: Crear header Authorization
  const authorization = [
    'AWS4-HMAC-SHA256 Credential=',
    `${process.env.AMAZON_ACCESS_KEY}/${credentialScope}`,
    `, SignedHeaders=${signedHeaders}`,
    `, Signature=${signature}`
  ].join('');
  
  return {
    'Authorization': authorization,
    'X-Amz-Date': amzDate,
    'X-Amz-Target': headers['X-Amz-Target'],
    'Content-Type': 'application/x-amz-json-1.1'
  };
}
```

**Validaciones:**
- Timestamp ±15 minutos del servidor Amazon (sincronizar reloj del servidor)
- Región debe coincidir: `us-east-1` (Norteamérica), `eu-west-1` (Europa), etc.
- Secret Key NUNCA se incluye en header (solo se usa para calcular firma)
- SignedHeaders debe listar exactamente qué headers se firmaron

### 6. Reintentos a Amazon API con Backoff Exponencial (F400 y Throttled)

**¿Por qué reintentos a Amazon?**
- **F400** ("Unknown state"): Error temporal del sistema Amazon, desaparece en segundos
- **Throttled**: Rate limit (>10 req/seg), esperar y reintentar
- **Máx 3 intentos** (diferente de los 5 reenvíos máximos de email al alumno)

**Estrategia de reintentos:**

```javascript
async function createGiftCardWithRetries(payload) {
  const maxRetries = 3;
  const baseDelayMs = 100;
  let attempt = 0;
  
  while (attempt < maxRetries) {
    try {
      // Llamar a Amazon
      const response = await callAmazonAPI(payload);
      
      // Éxito
      if (response.statusCode === 'SUCCESS') {
        return {
          success: true,
          code: response.gcClaimCode
        };
      }
      
      // Error F400 (reintentable)
      if (response.errorCode === 'F400' && attempt < maxRetries - 1) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);  // 100, 200, 400
        console.log(`F400 en intento ${attempt + 1}, reintentando en ${delayMs}ms...`);
        await sleep(delayMs);
        attempt++;
        continue;
      }
      
      // Error Throttled (reintentable)
      if (response.statusCode === 'Throttled' && attempt < maxRetries - 1) {
        const delayMs = 1000 + Math.random() * 1000;  // 1-2 segundos aleatorio
        console.log(`Throttled, esperando ${delayMs}ms...`);
        await sleep(delayMs);
        attempt++;
        continue;
      }
      
      // Otros errores: no reintentar
      return {
        success: false,
        errorCode: response.errorCode,
        message: response.message
      };
      
    } catch (error) {
      // Error de red: reintentar (si es el primer intento)
      if (attempt < maxRetries - 1 && isNetworkError(error)) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.log(`Error de red, reintentando en ${delayMs}ms...`);
        await sleep(delayMs);
        attempt++;
        continue;
      }
      
      // Error fatal
      return {
        success: false,
        errorCode: 'NETWORK_ERROR',
        message: error.message
      };
    }
  }
  
  // Exhausted retries
  return {
    success: false,
    errorCode: 'MAX_RETRIES_EXCEEDED',
    message: 'No se pudo obtener respuesta de Amazon después de 3 intentos'
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isNetworkError(error) {
  return error.code === 'ECONNREFUSED' || 
         error.code === 'ETIMEDOUT' ||
         error.code === 'ENOTFOUND';
}
```

**Logging de reintentos:**

```javascript
// Cada reintento se registra
await bigquery.table('access_logs').insert({
  gift_card_id: giftCardId,
  action: 'amazon_error',
  amazon_error_code: 'F400',
  amazon_error_msg: 'Unknown state - reintentando intento 2/3',
  performed_by: 'scheduler',
  source_ip: serverIp
});
```

**Casos especiales:**

1. **Idempotencia en reintentos:**
   - Usar MISMO `creationRequestId` en todos los reintentos
   - Si Amazon responde con éxito en reintento 2, pero la BD ya tiene el código del reintento 1
   - Comparar: si `creation_request_id` ya existe, usar código existente (no duplicar)

2. **Timeout a nivel de HTTP:**
   ```javascript
   const axios = require('axios');
   
   const client = axios.create({
     timeout: 30000,  // 30 segundos max
     httpAgent: new http.Agent({ keepAlive: true }),
     httpsAgent: new https.Agent({ keepAlive: true })
   });
   ```

3. **No reintentar en estos casos:**
   - F100: Error interno de Amazon → contactar soporte
   - F200: Request inválido → revisar firma AWS Sig V4
   - F300: Fondos insuficientes → recargar fondos
   - F500: Error desconocido → puede ser outage, contactar soporte

### 4. Alertas automáticas a CRM (crm@acme-example.com)

**Cuándo enviar alertas:**

| Evento | Destinatario | Asunto | Acción requerida |
|---|---|---|---|
| Fondos insuficientes en Amazon | crm@acme-example.com | [ALERTA] Fondos insuficientes en Amazon Incentives API | Recargar fondos en Seller Central |
| Error F100 (interno de Amazon) | crm@acme-example.com | [ALERTA] Error interno en Amazon Incentives API | Contactar a soporte de Amazon |
| Error F200 (request inválido) | crm@acme-example.com | [CRÍTICO] Error de autenticación Amazon API | Revisar credenciales AWS |
| Error F500 (desconocido) | crm@acme-example.com | [ALERTA] Error desconocido en Amazon Incentives API | Contactar a Amazon, puede ser outage |
| 10+ errores en 1 hora | crm@acme-example.com | [CRÍTICO] Tasa de errores alta en generación de gift cards | Investigar y posible rollback |

**Plantilla de email:**
```
Asunto: [ALERTA] Fondos insuficientes en Amazon Incentives API

Cuerpo:
─────────────────────────────────────────
ALERTA: Fondos insuficientes

Referido ID: 12345
Contacto: Juan Pérez (juan@example.com)
Monto solicitado: $50.00 USD
Saldo disponible: $23.50 USD
Timestamp: 2026-06-10 09:00:01 UTC

Acción requerida:
Recargar fondos en Amazon Seller Central: https://sellercentral.amazon.com
Monto mínimo recomendado: $5,000 USD

Después de recargar, el scheduler automático reintentará mañana.
─────────────────────────────────────────
```

**Implementación:**
```javascript
async function sendAlertToTeam(alertType, details) {
  const templates = {
    insufficient_funds: {
      subject: '[ALERTA] Fondos insuficientes en Amazon Incentives API',
      body: `Monto solicitado: $${(details.amount / 100).toFixed(2)}\n...`
    },
    amazon_error_f100: {
      subject: '[ALERTA] Error interno en Amazon Incentives API',
      body: 'Contactar a soporte de Amazon...'
    }
  };
  
  await sendgrid.send({
    to: 'crm@acme-example.com',
    from: 'noreply@acme-example.com',
    subject: templates[alertType].subject,
    text: templates[alertType].body,
    html: `<pre>${templates[alertType].body}</pre>`
  });
  
  // También registrar en access_logs para auditoría
  await bigquery.table('access_logs').insert({
    gift_card_id: null,  // No específico de un código
    action: 'alert_sent',
    alert_type: alertType,
    performed_by: 'system',
    source_ip: serverIp
  });
}
```

### 5. Campos de auditoría en módulo Referidos (CRM)

Los admins de Zoho ven estos campos pero **NUNCA el código:**

| Campo | Tipo | Descripción |
|---|---|---|
| `Gift_Card_Enviada` | Checkbox | Si fue procesada |
| `Gift_Card_Enviada_Fecha` | Fecha/Hora | Cuándo se envió |
| `Gift_Card_SendGrid_ID` | Texto | ID para cruzar con SendGrid |
| `Gift_Card_Email_Status` | Texto | sent / bounced / opened / etc |
| `Gift_Card_Bounce_Reason` | Texto | Motivo de rechazo EN ESPAÑOL (ej: "Email inválido") |
| `Gift_Card_Abierto_Fecha` | Fecha/Hora | Cuándo abrió el email |
| `Gift_Card_Reenvios` | Número | Cuántas veces se relanzó |
| `Gift_Card_Ultimo_Reenvio` | Fecha/Hora | Fecha del último reenvío |

### 5. Botón de reenvío en CRM

- Custom Button en módulo Referidos: **"Relanzar Gift Card"**
- Llama a `POST /gift-cards/resend` con el `referidoId`
- Node usa siempre el email original guardado en BigQuery (el agente no puede redirigir el código)
- CRM actualiza campos de auditoría
- Si `Gift_Card_Abierto_Fecha` tiene fecha → el alumno ya lo abrió → posible fraude

### 6. Zoho Deluge (Scheduler automático)

```deluge
referidos = zoho.crm.getRecords("Referidos",
  "criteria=Gift_Card_Enviada:equals:false"
);

for each referido in referidos
{
  fechaMatricula = referido.get("Fecha_Matricula");
  diasDesdeMatricula = zoho.currentDate.diff(fechaMatricula, "days");
  contactId = referido.get("Contact_ID");
  
  if(diasDesdeMatricula >= 20)
  {
    payload = {
      "referidoId": referido.get("id"),
      "contactId": contactId,
      "contactEmail": referido.get("Email"),
      "contactName": referido.get("Nombre")
    };
    
    response = invokeUrl
    [
      url: "https://tu-api.cloud/gift-cards/process"
      type: POST
      parameters: payload
      headers: {"x-api-key": "TU_API_KEY_SECRETA"}
    ];
    
    if(response.get("success") == true)
    {
      updateFields = {
        "Gift_Card_SendGrid_ID": response.get("sendgridMessageId"),
        "Gift_Card_Email_Status": "sent"
      };
      
      // Solo marcar como enviada si es el PRIMER envío (status devuelto es "generated")
      if(response.get("status") == "generated")
      {
        updateFields["Gift_Card_Enviada"] = true;
        updateFields["Gift_Card_Enviada_Fecha"] = zoho.currentTime;
      }
      // Si status es "resent", no actualizar Gift_Card_Enviada (ya estaba en true)
      
      zoho.crm.updateRecord("Referidos", referido.get("id"), updateFields);
    }
    else if(response.get("reason") == "validation_failed")
    {
      zoho.crm.updateRecord("Referidos", referido.get("id"), {
        "Gift_Card_Email_Status": "Envío no cumple requisitos"
      });
    }
    else if(response.get("status") == "bounced")
    {
      zoho.crm.updateRecord("Referidos", referido.get("id"), {
        "Gift_Card_Email_Status": "bounced",
        "Gift_Card_Bounce_Reason": response.get("reason")
      });
    }
    else
    {
      zoho.crm.updateRecord("Referidos", referido.get("id"), {
        "Gift_Card_Email_Status": response.get("detail")
      });
    }
  }
}
```

## Flujo completo

### Caso exitoso (NUEVO referido, primer envío):
1. Alumno se matricula → Invoice creado + Registro en Referidos
2. Cada día: Scheduler Zoho busca referidos con 20+ días sin gift card
3. Zoho llama `POST /gift-cards/process` con referidoId + contactId + email + nombre
4. **API verifica si referido ya fue procesado:**
   ```
   SELECT * FROM gift_cards WHERE referido_id = {referidoId}
   ```
   - NO existe → Proceder a generar nuevo código ✅
5. **API valida requisitos en Zoho:**
   - ¿Contact tiene Invoice en estado "matriculado"? ✅
   - ¿Referido tiene Invoice en estado "matriculado" hace >20 días? ✅
6. API llama Amazon API → recibe código nuevo
7. API encripta código AES-256 **inmediatamente** → guarda en BigQuery
8. API registra en `access_logs`: acción `generated`, IP del servidor
9. API envía email al alumno vía SendGrid con código
10. API guarda `sendgrid_message_id` en BigQuery
11. API retorna `{success: true, status: "generated", sendgridMessageId}` a Zoho
12. Zoho actualiza campos en Referidos:
    - `Gift_Card_Enviada = true`
    - `Gift_Card_Email_Status = "sent"`

### Caso de reenvío (referido YA procesado):
1. Scheduler Zoho llama `POST /gift-cards/process` con referidoId (por reintentos automáticos, error de red, o reintento manual)
2. **API verifica si referido ya fue procesado:**
   ```
   SELECT * FROM gift_cards WHERE referido_id = {referidoId}
   ```
   - SÍ existe → Proceder a REENVIAR ✅
3. **NO valida requisitos** (ya fueron validados en primer envío)
4. **NO llama a Amazon API**
5. Obtiene `amazon_code_encrypted` de la tabla
6. Desencripta código AES-256 (solo en memoria)
7. API registra en `access_logs`: acción `resent`, IP del servidor
8. API envía email al alumno vía SendGrid con el MISMO código
9. Actualiza en BigQuery:
   - `sendgrid_message_id` = nuevo ID del reenvío
   - `email_resent_count` += 1
   - `email_last_resent_at` = ahora
10. API retorna `{success: true, status: "resent", sendgridMessageId}` a Zoho
11. Zoho actualiza `Gift_Card_Email_Status = "sent"` (fue enviado otra vez)

### Caso de validación fallida (referido NUEVO, no cumple requisitos):
1. Alumno se matricula → Invoice creado + Registro en Referidos
2. Cada día: Scheduler Zoho busca referidos con 20+ días sin gift card
3. Zoho llama `POST /gift-cards/process` con referidoId + contactId + email + nombre
4. **API verifica si referido ya fue procesado:**
   ```
   SELECT * FROM gift_cards WHERE referido_id = {referidoId}
   ```
   - NO existe → Proceder a generar nuevo código
5. **API valida requisitos en Zoho:**
   - ¿Contact tiene Invoice en estado "matriculado"? ❌ O
   - ¿Referido tiene Invoice en estado "matriculado" hace >20 días? ❌
6. **Validación falla:**
   - NO generar código Amazon
   - NO encriptar
   - NO guardar en BigQuery
   - Registra en `access_logs`: acción `validation_failed`, motivo específico
   - Retorna `{success: false, reason: "validation_failed", detail: "contact_invoice_not_found" | "referido_invoice_not_found" | "referido_matrícula_menos_20_días"}`
7. Zoho actualiza Referidos:
   - `Gift_Card_Email_Status = "Envío no cumple requisitos"`
8. **Nota:** El scheduler volverá a intentar mañana. Si las condiciones se cumplen (Invoice matriculado >20 días), entonces sí generará el código

### Caso de rechazo (bounce - referido NUEVO):
1-10. Igual al caso exitoso (validación ✅, código generado y encriptado)
11. API intenta enviar por SendGrid
12. **SendGrid rechaza**: `{error: "Mailbox full"}`
13. API convierte a español: `"Buzón lleno"`
14. API guarda en BigQuery:
    - `email_status = "bounced"`
    - `bounce_reason_es = "Buzón lleno"`
15. API registra en `access_logs`: acción `generated` (el código fue generado, no importa si el email falló)
16. API retorna `{success: false, status: "bounced", reason: "Buzón lleno"}` a Zoho
17. Zoho actualiza Referidos:
    - `Gift_Card_Email_Status = "bounced"`
    - `Gift_Card_Bounce_Reason = "Buzón lleno"`
18. **Agente CRM ve el motivo** y contacta al alumno
19. Alumno proporciona email válido
20. **Nota importante:** El código YA fue generado y guardado. Si agente intenta "Relanzar Gift Card" (o scheduler lo reintenta), el sistema detectará que ya existe y REENVIAR`A el mismo código al email original (no se puede cambiar el destinatario del código una vez generado por seguridad)

## Cadena de evidencia completa (casos de fraude)

| Dato | Fuente | Valor probatorio |
|---|---|---|
| Matrícula del alumno | Zoho CRM | Alto |
| Código generado para ese alumno | BigQuery `gift_cards` | Alto |
| Log de quién en nuestra BD accedió al código y desde qué IP | BigQuery `access_logs` + Cloud Logging | Alto |
| Email enviado a dirección original | BigQuery `gift_cards` + SendGrid | Alto |
| IP + timestamp de apertura del email | SendGrid (tercero independiente) | Medio-Alto |
| Dispositivo/cliente de email | SendGrid | Medio |
| **Canje del código en Amazon** | Amazon Incentives API Portal (manual, no automático) | Alto pero requiere acción manual |

**Nota importante:** Amazon **NO proporciona por API** información sobre cuándo se canjeó un código. Para auditoría completa:
1. SendGrid te dice: ¿abrió el email el usuario? ¿desde qué IP?
2. Amazon Dashboard te dice: ¿fue canjeado el código? ¿en qué fecha?
3. Cruzar IPs: si la IP de SendGrid ≠ IP de Amazon = códigos enviados pero canjeados desde otra ubicación

**En caso de disputa:**
> "El código fue generado y enviado al email registrado en la matrícula. Los logs de acceso demuestran que nadie de la empresa accedió al código. SendGrid (tercero independiente) registra que el email fue abierto desde IP X el 2026-06-12 09:30 UTC desde dispositivo iPhone. Amazon Dashboard muestra que el código fue canjeado el mismo día 09:35 UTC. Las IPs son consistentes con un acceso legítimo del usuario."

**O en caso de fraude sospechoso:**
> "El código fue enviado a juan@example.com y abierto desde IP 200.100.50.1 (Argentina) el 2026-06-12 09:30 UTC. Sin embargo, Amazon Dashboard muestra que fue canjeado desde IP 203.45.67.89 (Australia) el mismo día a las 11:00 UTC. Esto sugiere que el email pudo haber sido comprometido o reenviado."

## Auditoría de canjes: Amazon Incentives API Portal

**¿Cómo saber si un código fue canjeado?**

Amazon **NO envía automáticamente** esta información por API. Debes consultarla manualmente:

1. **Acceder al Incentives API Portal:**
   - URL: https://incentives-api.amazon.com (requiere credenciales)
   - Dashboard: "Transaction Activity" o "Reports"

2. **Descargar reporte de transacciones:**
   - Filtrar por fecha de creación del código
   - Buscar el `creationRequestId` o rango de códigos
   - Reporte muestra: fecha de canje, estado, monto

3. **Para cruzar con SendGrid:**
   - SendGrid: fecha/hora de apertura del email + IP
   - Amazon: fecha/hora de canje del código + IP (si está disponible)
   - Comparar: ¿mismo usuario? ¿misma ubicación? ¿tiempos consistentes?

4. **En caso de disputa:**
   - ACME descarga el reporte de Amazon
   - Cruza con logs de SendGrid
   - Documenta en ticket de auditoría

**Limitación actual:** Esta es una operación MANUAL. Amazon podría en el futuro proporcionar webhooks o una API de consulta de estado, pero por ahora no existe.

---

## Separación de responsabilidades (developer vs ACME)

### Responsabilidades del Developer

**Lo que asume (técnico):**
- ✅ Implementar sistema seguro: encriptación, auditoría, logging
- ✅ Garantizar que los códigos nunca se logueen en texto plano
- ✅ Garantizar que los códigos nunca aparezcan en Zoho CRM
- ✅ Configurar Cloud Logging para que sea inmutable
- ✅ Crear rol "Gift Cards Auditor" para ACME
- ✅ Documentar endpoints y flujos técnicos
- ✅ Responder a preguntas técnicas sobre cómo se registra cada acción

**Lo que NO asume:**
- ❌ Decisiones sobre si hay fraude o no (eso lo investiga ACME)
- ❌ Decisiones legales sobre los términos y conditions (eso lo maneja Legal)
- ❌ Gestión operativa de la campaña (eso lo hace Marketing)
- ❌ Auditoría de accesos (eso lo hace ACME de forma independiente)
- ❌ Responsabilidad de disputas entre ACME y clientes

### Responsabilidades de ACME

**Lo que asume (auditoría y compliance):**
- ✅ Acceso directo a Cloud Logging sin pasar por el developer
- ✅ Investigar cualquier sospecha de acceso indebido
- ✅ Auditar regularmente los logs para detectar anomalías
- ✅ Comparar IPs de SendGrid, Amazon y Cloud Logging
- ✅ Tomar decisiones sobre si hubo fraude o disputa
- ✅ Responder a reclamaciones de clientes con evidencia técnica
- ✅ Redactar y mantener términos y conditions legales

**Lo que NO asume:**
- ❌ Acceso al código fuente (no lo necesita para auditar)
- ❌ Acceso directo a BigQuery (Cloud Logging es suficiente)
- ❌ Implementación técnica del sistema

### En caso de disputa o sospecha de fraude

**Flujo:**
1. Cliente/ACME reporta problema con un código
2. ACME accede a Cloud Logging directamente (sin pasar por developer)
3. ACME filtra por `GIFT_CARD_ID` del código en disputa
4. Ve todas las acciones: quién, cuándo, desde qué IP
5. Cruza datos con SendGrid y Amazon
6. Compara IPs: si coinciden con equipos de desarrollo → evidencia
7. ACME toma decisión: ¿fue fraude interno? ¿fue compromiso del email del cliente?

**El developer solo responde a preguntas técnicas:**
- "¿Por qué aparece esta acción en los logs?"
- "¿Qué significa este estado?"
- "¿Cómo funciona este flujo?"

**ACME decide:**
- Si hubo fraude
- Qué acciones tomar
- Si el developer cometió algo indebido

### Protección mutua

Esta separación protege a **ambas partes:**

| Escenario | Developer protegido | ACME protegida |
|---|---|---|
| Código filtrado | Logs demuestran que él no lo tomó | Puede investigar independientemente |
| Disputa cliente | Logs muestran quién lo abrió/canjeó | Evidencia para resolver disputa |
| Acceso indebido | Logs quedarían registrados en Cloud | Puede detectarlo sin depender del dev |
| Cambio de código | GitHub audita cambios, PRs obligatorios | Cloud Logging es inmutable |

### Por qué funciona esta estructura

- El developer no tiene poder de decisión sobre fraudes → no tiene incentivo para cubrirlos
- ACME tiene acceso independiente a los logs → puede auditar sin confiar ciegamente en el dev
- Todo es auditado y documentado → imposible negar qué pasó
- Los logs están en infraestructura de Google Cloud → más seguros que en manos privadas

## Seguridad del repositorio

- Repo privado con acceso restringido
- **Branch protection en `main`**: push directo bloqueado
- Todo cambio vía Pull Request con aprobación obligatoria del owner
- Auditoría completa de cambios en GitHub
- Devs pueden acceder para mantenimiento pero ningún cambio llega a producción sin aprobación

## Frontera de seguridad

```
Zoho (3 devs con Zoho One)          Google Cloud (solo owner)
─────────────────────────           ──────────────────────────────────
Módulo Referidos:                   Node.js API
  Gift_Card_Enviada: true/false      BigQuery:
  Gift_Card_Enviada_Fecha              - gift_cards (códigos encriptados)
  Gift_Card_Email_Status               - access_logs (quién accedió y cuándo)
  (NUNCA el código)                  Cloud Logging (inmutable, solo lectura para ACME)
```

## Cómo ACME audita que nadie accedió a los códigos (auditoría imposible de falsificar)

### El problema de fondo

**Escenario de riesgo:**
Un developer malicioso podría:
1. Acceder a BigQuery y desencriptar un código
2. Usarlo (canjearlo en Amazon, venderlo, etc.)
3. Intentar borrar los logs de `access_logs` para esconder evidencia

**¿Cómo impedimos esto?**

### Solución: Capas de auditoría independientes e inmutables

La seguridad está en que **NO hay una sola fuente de verdad que el dev pueda editar**. Hay CUATRO fuentes:

```
┌────────────────────────────────────────────────────────────────┐
│ CAPAS DE AUDITORÍA (todas registran intentos de fraude)        │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│ 1. Cloud Logging (GCP) - INMUTABLE ⭐ CRITICAL         │
│    ├─ Solo lectura para ACME                            │
│    ├─ Developer NO tiene permisos para editar                │
│    ├─ Registra TODOS los accesos a BigQuery                 │
│    ├─ Registra intentos de DELETE/UPDATE                    │
│    └─ Registra cambios en permisos de IAM                   │
│                                                                │
│ 2. BigQuery Change Log (built-in)                             │
│    ├─ Cada INSERT/UPDATE/DELETE está timestampado           │
│    ├─ ACME puede auditar qué se modificó              │
│    ├─ Si developer borra rows → change log lo registra      │
│    └─ No se puede editar histórico                          │
│                                                                │
│ 3. SendGrid (tercero independiente)                            │
│    ├─ Email enviado a dirección específica                  │
│    ├─ Timestamp de apertura                                 │
│    ├─ IP de apertura                                        │
│    ├─ Developer no controla estos datos                     │
│    └─ SendGrid no desaparece logs porque developer quiera  │
│                                                                │
│ 4. Amazon Dashboard (tercero independiente)                    │
│    ├─ Registro de códigos canjeados                         │
│    ├─ Timestamp exacto de canje                             │
│    ├─ Developer no controla Amazon                          │
│    └─ Imposible falsificar historial de canjes             │
│                                                                │
│ 5. GitHub (auditoría de cambios en código)                    │
│    ├─ Quién cambió el código y cuándo                       │
│    ├─ Si dev removió logging → queda en historio de commits│
│    ├─ Commits inmutables (no se pueden editar)             │
│    └─ Correlaciona cambios con intentos de fraude          │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Por qué Cloud Logging es imposible de manipular:

**Arquitectura de permisos:**

```
Developer (dev@acme-example.com)
├─ IAM Role: "GCP Admin" (para deploy + desarrollo)
│  ├─ ✅ Puede: editar código, deploy, modificar BigQuery, Cloud Run
│  └─ ❌ NO puede: editar Cloud Logging
│
ACME (auditor@acme-example.com) 
├─ IAM Role: "Gift Cards Auditor" (solo lectura)
│  ├─ ✅ Puede: leer Cloud Logging, leer BigQuery (queries)
│  ├─ ✅ Puede: ver cambios en BigQuery (change logs)
│  └─ ❌ NO puede: editar BD, modificar código, deploy
```

**Cloud Logging es controlado por GCP, no por ti.** Cuando el dev intenta editarlo:

```
[14:32:15] UNAUTHORIZED_ACTION: dev@acme-example.com attempted to modify Cloud Logging
[14:32:15] ACTION_TYPE: DELETE_LOGS
[14:32:15] RESULT: DENIED (insufficient permissions)
[14:32:15] SOURCE_IP: 85.123.45.67
```

Este evento TAMBIÉN se registra (en otro log que dev no puede editar).

### Escenario de fraude detectado (paso a paso):

**Intento de fraude:**
Developer quiere desencriptar código ABC-DEF-GHI-JKL y usarlo.

**Timeline de lo que sucede:**

```
14:20 UTC - Dev modifica código
  GitHub commit: "remove debug logging"
  Author: dev2@acme-example.com
  Changed file: src/utils/logger.js (removed console.log statements)
  ✅ Cloud Logging: registra este cambio

14:25 UTC - Dev accede a BigQuery
  Cloud Logging: dev2@acme-example.com connected to BigQuery
  Cloud Logging: Query executed: SELECT amazon_code_encrypted...
  Cloud Logging: Source IP: 203.45.67.89
  BigQuery Change Log: Query executed at 14:25:30 UTC
  ✅ ACME ve: "David ejecutó SELECT de códigos encriptados"

14:26 UTC - Dev desencripta código
  Cloud Logging: decrypt() function called
  Cloud Logging: Source IP: 203.45.67.89
  ✅ ACME ve: "Se llamó función de desencriptación"

14:30 UTC - Código se canjea en Amazon
  SendGrid: Email abierto desde IP 203.45.67.89 a las 14:29:45
  Amazon: Código ABC-DEF-GHI-JKL canjeado a las 14:30:12
  Amazon: Canje desde IP ??? (AWS no lo divulga)
  ✅ ACME ve: "El código fue canjeado poco después de que David lo desencriptara"

14:32 UTC - Dev intenta borrar logs
  Dev ejecuta: DELETE FROM access_logs WHERE gift_card_id = 'xyz'
  
  Cloud Logging: dev2@acme-example.com executed DELETE query
  Cloud Logging: Table: access_logs
  Cloud Logging: Rows affected: 1
  Cloud Logging: Full query text: DELETE FROM access_logs...
  Cloud Logging: Timestamp: 14:32:45 UTC
  
  BigQuery Change Log: 1 row deleted from access_logs
  BigQuery Change Log: Timestamp: 14:32:45 UTC
  BigQuery Change Log: User: dev2@acme-example.com
  
  ✅ ACME ve: "El desarrollador intentó eliminar registros justo después de que se canjeara el código"

14:35 UTC - ACME audita
  Revisa Cloud Logging (inmutable, dev no puede tocar)
  Ve la correlación temporal:
  
  ✓ 14:20 - Código de logging removido (GitHub)
  ✓ 14:25 - SELECT de códigos encriptados (Cloud Logging)
  ✓ 14:26 - decrypt() llamado (Cloud Logging)
  ✓ 14:29 - Email abierto desde IP exacta (SendGrid)
  ✓ 14:30 - Código canjeado en Amazon (Amazon Dashboard)
  ✓ 14:32 - DELETE query para cubrir huellas (Cloud Logging + BigQuery Change Log)
  
  CONCLUSIÓN: Fraude confirmado. Evidencia irrefutable.
```

### ¿Qué pasa si dev intenta editar Cloud Logging?

```
dev@acme-example.com intenta: gcloud logging delete logs "activity" --all

GCP responde: ERROR: (gcloud.logging.delete) User does not have permission 
              compute.instances.delete on resource.
```

El intento TAMBIÉN se registra en Cloud Logging (en un log de auditoría más alto que dev no puede tocar).

### Sanitizer: prevenir que datos sensibles lleguen a los logs

Además de la auditoría inmutable, usamos **sanitizer** para que ni siquiera los logs normales contengan códigos. Si un dev accidentalmente hace:

```javascript
logger.info(`Processing gift card: ${code}`);
```

El sanitizer automáticamente reemplaza:

```
[INFO] Processing gift card: [REDACTED]
```

**Beneficio:** Incluso si Cloud Logging es comprometido por un atacante externo, los códigos NO están ahí.

### Resumen de defensa en capas:

| Línea de defensa | Propósito | Quién la controla |
|---|---|---|
| **Cloud Logging (inmutable)** | Fuente de verdad independiente | GCP, NO developer |
| **BigQuery Change Log** | Auditar qué se modificó | GCP automático |
| **Sanitizer en logs** | No loguear códigos sensibles | Developer (pero validado) |
| **SendGrid (tercero)** | Confirmar email fue abierto | SendGrid, independiente |
| **Amazon Dashboard** | Confirmar código fue canjeado | Amazon, independiente |
| **GitHub Change Log** | Auditar modificaciones de código | GitHub, versionado para siempre |

**Conclusión:** 
Es **prácticamente imposible** que un developer oculte fraude porque:
1. Cloud Logging está fuera de su control
2. Los intentos de ocultamiento TAMBIÉN se registran
3. Hay 3 terceros independientes (SendGrid, Amazon, GitHub) con su propio registro
4. La correlación temporal de eventos es irrefutable

### Qué queda registrado en cada acción

**Acción normal (sistema automático):**
```
[2026-06-10 09:00:01] ACTION=generated  GIFT_CARD_ID=uuid-123
                       PERFORMED_BY=scheduler  SOURCE_IP=10.0.0.1 (IP interna del servidor)
[2026-06-10 09:00:02] ACTION=sent       GIFT_CARD_ID=uuid-123
                       PERFORMED_BY=scheduler  SOURCE_IP=10.0.0.1
```

**Si un developer accede indebidamente:**
```
[2026-06-10 14:32:11] ACTION=decrypted  GIFT_CARD_ID=uuid-123
                       PERFORMED_BY=dev@acme-example.com  SOURCE_IP=85.123.45.67
                       ⚠️  ALERTA: Acceso manual fuera de flujo automático
```

**Si se hace un reenvío desde CRM:**
```
[2026-06-10 16:15:03] ACTION=resent     GIFT_CARD_ID=uuid-123
                       PERFORMED_BY=agent@acme-example.com  SOURCE_IP=85.123.45.68
                       ZOHO_USER=nombre_agente
```

### Alertas automáticas

Configurar alerta en GCP que notifique a ACME si:
- Se registra `ACTION=decrypted` fuera del flujo `scheduler`
- Se accede a la BD desde una IP que no sea la del servidor
- Se realizan más de X reenvíos en un día

### Ruta de auditoría para ACME

Si hay una disputa o sospecha de acceso indebido:

1. **ACME accede a Cloud Logging** (sin pasar por el developer)
2. **Filtra por** `GIFT_CARD_ID` del código en disputa
3. **Ve todas las acciones** sobre ese código: quién, cuándo, desde qué IP
4. **Cruza con SendGrid**: a qué IP llegó el email y cuándo se abrió
5. **Cruza con Amazon**: desde qué IP se canjeó (si Amazon lo provee)
6. **Compara IPs**: si alguna IP coincide con las del equipo de desarrollo → evidencia de acceso indebido

### Configuración necesaria en GCP

- Crear rol **"Gift Cards Auditor"** en GCP: solo lectura de Cloud Logging
- Asignar ese rol a IT/compliance/dirección de ACME
- Configurar alertas automáticas por accesos anómalos
- **Retención de logs**: mínimo 1 año (por si hay disputa tardía)

> **Importante:** Esta configuración la hace el developer al montar el sistema, pero el acceso a los logs queda en manos de ACME. El developer no puede borrar logs de Cloud Logging sin que quede rastro de esa acción también.

## Términos y condiciones (pendiente redacción legal)

Incluir en los términos de la campaña:
- El código se envía al email registrado en la matrícula
- La empresa no se responsabiliza del uso del código una vez entregado al email del alumno
- En caso de disputa, la empresa aportará evidencia técnica del envío (logs, auditoría SendGrid, Amazon)
- La seguridad del email del alumno es responsabilidad del alumno

> **Validar con asesor legal:** valor probatorio de reportes SendGrid bajo RGPD, uso de IPs como evidencia, y redacción de los términos de la campaña.

## Pendientes a validar

- [ ] ¿Proyecto de BigQuery disponible? ¿Dataset donde guardar las tablas?
- [ ] Credenciales Amazon API (¿están listas? ¿proporcionan IP de canje?)
- [ ] Deploy en Google Cloud Run configurado y funcionando
- [ ] ¿En qué campo del módulo Referidos está el email del alumno?
- [ ] ¿El importe de la gift card es fijo o variable?
- [ ] SendGrid: ¿cuenta existente o hay que contratar?
- [ ] Validar con asesor legal: términos campaña + valor probatorio SendGrid bajo RGPD
- [ ] Configurar rol "Gift Cards Auditor" en GCP para IT/compliance/dirección
- [ ] Definir retención de logs (mínimo 1 año recomendado)
- [ ] Definir umbral de alertas automáticas por accesos anómalos

## Testing

1. **Sandbox Amazon** → Configurar env `AMAZON_ENV=sandbox`
2. Crear registro de prueba en Referidos con fecha hace 21 días
3. Trigger manual del scheduler → Verificar:
   - API recibe llamada
   - Amazon devuelve código (sandbox)
   - Código guardado encriptado en `gift_cards`
   - Acción registrada en `access_logs`
   - Email enviado al alumno con código visible
   - `sendgrid_message_id` guardado en BigQuery
   - Referido actualizado en Zoho con datos de auditoría
4. Verificar que en Zoho CRM **no hay rastro del código**
5. Cruzar datos: BigQuery ↔ SendGrid Activity Feed
6. Verificar que un reenvío usa siempre el email original (no el editado en CRM)
7. Cambiar a `AMAZON_ENV=production` para go live

## Plan de trabajo detallado para el equipo de desarrollo

---

## Timeline Real: 4 Semanas (22 mayo - 10 junio 2026)

### Semana 1: 22-23 mayo (Jueves-Viernes) — Setup crítico
**Responsable: Developer**

- [ ] **GARANTIZAR sincronización de reloj NTP** (CRÍTICO) (30min)
  - ❌ Sin esto: AWS Signature V4 fallará
  - Servidor Node.js debe tener NTP activo
  - Reloj debe estar dentro de ±5 minutos de UTC
  - En desarrollo local: sincronizar manualmente
    ```bash
    # macOS
    ntpdate -s time.apple.com
    
    # Linux
    sudo timedatectl set-ntp true
    
    # Verificar
    date +%s  # Comparar con https://www.epochconverter.com
    ```
  - En Cloud Run: automático (verificar con script de test)
  - En BigQuery: logs usarán timestamp correcto
  - En SendGrid: timestamps coincidirán con eventos reales
  - En auditoría: correlación cronológica será exacta

- [ ] Reunión con equipo BigData: ¿Proyecto BigQuery disponible? ¿Acceso y dataset? (2h)
- [ ] Verificar credenciales Amazon API: acceso, documentación, sandbox disponible (2h)
- [ ] Confirmar si SendGrid está contratado o gestionarlo con el proveedor (1h)
- [ ] Crear proyecto en GCP y configurar entorno (2h)
- [ ] Crear repo privado en GitHub con branch protection (1h)
- [ ] Coordinar con equipo BigData: crear dataset en BigQuery y dar acceso a la API (1h)
- [ ] Confirmar con equipo Zoho qué campo del módulo Referidos contiene el email del alumno (1h)
- [ ] Confirmar importe de la gift card (fijo o variable) con marketing (30min)

**Entregable:** Entorno listo, credenciales validadas, BD operativa

---

### Semana 2: 26-30 mayo (Lunes-Viernes) — Desarrollo API core

**Responsable: Developer**

**npm packages necesarios:**
```json
{
  "express": "^4.18.2",           // Framework HTTP
  "aws4": "^1.12.0",              // Firma AWS Signature V4
  "@google-cloud/bigquery": "^7.0.0",  // BigQuery client
  "@sendgrid/mail": "^8.1.0",     // SendGrid SDK
  "uuid": "^9.0.0",               // UUID para creationRequestId
  "crypto": "built-in",           // AES-256 encryption (nativo)
  "dotenv": "^16.3.1",            // Variables de entorno
  "axios": "^1.6.0"               // HTTP client (para Amazon API)
}
```

- [ ] Estructura del proyecto Node.js + Express (1h)
  ```
  project/
  ├── src/
  │   ├── index.js              (punto de entrada Express)
  │   ├── routes/
  │   │   └── giftCards.js      (endpoints POST /gift-cards/process, /gift-cards/resend)
  │   ├── services/
  │   │   ├── amazon.js         (llamadas a Amazon API + firma AWS4)
  │   │   ├── encryption.js     (AES-256 encrypt/decrypt)
  │   │   ├── bigquery.js       (queries a BigQuery)
  │   │   ├── sendgrid.js       (envío de emails)
  │   │   └── zoho.js           (queries a Zoho CRM)
  │   └── utils/
  │       ├── logger.js         (logging sin código en texto plano)
  │       └── errors.js         (manejo de errores)
  ├── .env                      (variables de entorno - NO en git)
  ├── .env.example              (template para .env)
  ├── package.json
  └── package-lock.json
  ```

- [ ] Configurar variables de entorno (.env) (30min)
  ```bash
  # Amazon
  AMAZON_ACCESS_KEY=AKIA...
  AMAZON_SECRET_KEY=...
  AMAZON_REGION=us-east-1
  AMAZON_PARTNER_ID=...
  AMAZON_ENV=sandbox|production
  
  # BigQuery
  GOOGLE_PROJECT_ID=...
  GOOGLE_DATASET_ID=...
  
  # SendGrid
  SENDGRID_API_KEY=...
  SENDGRID_FROM_EMAIL=noreply@acme-example.com
  SENDGRID_TEMPLATE_ID=d-...
  
  # Zoho CRM
  ZOHO_API_URL=https://www.zohoapis.com
  ZOHO_AUTH_TOKEN=...
  
  # Alertas
  CRM_ALERT_EMAIL=crm@acme-example.com
  
  # API Security
  API_KEY=tu-key-secreto-largo-aleatorio
  API_PORT=3000
  
  # Encryption
  ENCRYPTION_KEY=32-caracteres-base64-para-aes256
  ```

- [ ] **Implementar autenticación AWS Signature Version 4 con aws4:** (1.5h)
  - Instalar: `npm install aws4`
  - Crear `src/services/amazon.js`
  - Función para firmar requests automáticamente
  - Manejo de timestamp (sincronizar con servidor Amazon)
**Ejemplo: Estructura del endpoint con Express + aws4:**

```javascript
// src/index.js
const express = require('express');
const giftCardsRouter = require('./routes/giftCards');

const app = express();
app.use(express.json());

// Middleware: validar API Key
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Routes
app.use('/gift-cards', giftCardsRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(process.env.API_PORT, () => {
  console.log(`API listening on port ${process.env.API_PORT}`);
});
```

```javascript
// src/routes/giftCards.js
const express = require('express');
const router = express.Router();
const amazonService = require('../services/amazon');
const encryptionService = require('../services/encryption');
const bigqueryService = require('../services/bigquery');
const sendgridService = require('../services/sendgrid');
const zohoService = require('../services/zoho');

router.post('/process', async (req, res) => {
  try {
    const { referidoId, contactId, contactEmail, contactName } = req.body;

    // Paso 1: Verificar si ya existe
    const existing = await bigqueryService.getGiftCard(referidoId);
    if (existing) {
      // REENVÍO
      return handleResend(existing, contactEmail, contactName, res);
    }

    // Paso 2: Validar requisitos en Zoho
    const isValid = await zohoService.validateRequirements(contactId, referidoId);
    if (!isValid) {
      await bigqueryService.logAction({
        action: 'validation_failed',
        referido_id: referidoId
      });
      return res.json({ success: false, reason: 'validation_failed' });
    }

    // Paso 3: Verificar fondos
    const funds = await amazonService.getAvailableFunds();
    if (funds < 50.00) { // Asumir $50 por tarjeta
      await sendgridService.sendAlertToTeam('insufficient_funds', {
        referidoId, amount: 50.00, available: funds
      });
      return res.json({ success: false, reason: 'insufficient_funds' });
    }

    // Paso 4: Generar código con reintentos
    const result = await amazonService.createGiftCardWithRetries({
      partnerId: process.env.AMAZON_PARTNER_ID,
      currencyCode: 'USD',
      amount: 5000, // $50.00
      creationRequestId: uuid()
    });

    if (!result.success) {
      await bigqueryService.logAction({
        action: 'amazon_error',
        amazon_error_code: result.errorCode,
        amazon_error_msg: result.message
      });
      return res.json(result);
    }

    // Paso 5: Encriptar y guardar
    const encrypted = encryptionService.encrypt(result.code);
    const giftCard = await bigqueryService.saveGiftCard({
      referido_id: referidoId,
      contact_email: contactEmail,
      amazon_code_encrypted: encrypted,
      amazon_creation_request_id: result.creationRequestId
    });

    await bigqueryService.logAction({
      action: 'generated',
      gift_card_id: giftCard.id,
      referido_id: referidoId
    });

    // Paso 6: Enviar email
    const decrypted = encryptionService.decrypt(encrypted);
    const sendgridResult = await sendgridService.send({
      to: contactEmail,
      templateId: process.env.SENDGRID_TEMPLATE_ID,
      dynamicTemplateData: {
        nombre: contactName,
        amazonCode: decrypted
      }
    });
    decrypted = null; // Limpiar memoria

    // Paso 7: Actualizar BD con messageId
    await bigqueryService.updateGiftCard(giftCard.id, {
      sendgrid_message_id: sendgridResult.messageId
    });

    res.json({
      success: true,
      status: 'generated',
      sendgridMessageId: sendgridResult.messageId
    });

  } catch (error) {
    console.error('Error:', error.message); // Sin detalles sensibles
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
```

```javascript
// src/services/amazon.js
const AWS4 = require('aws4');
const axios = require('axios');

async function createGiftCardWithRetries(payload) {
  const maxRetries = 3;
  const baseDelayMs = 100;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await createGiftCard(payload);
      
      if (response.statusCode === 'SUCCESS') {
        return { success: true, code: response.gcClaimCode, creationRequestId: payload.creationRequestId };
      }
      
      if (response.errorCode === 'F400' && attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      // Otros errores: no reintentar
      return { 
        success: false, 
        errorCode: response.errorCode, 
        message: response.message 
      };
      
    } catch (error) {
      if (attempt < maxRetries - 1 && isNetworkError(error)) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return { success: false, errorCode: 'NETWORK_ERROR', message: error.message };
    }
  }
  
  return { success: false, errorCode: 'MAX_RETRIES', message: 'Exhausted retries' };
}

async function createGiftCard(payload) {
  // Firmar request con AWS4
  const request = {
    host: process.env.AMAZON_ENV === 'production' 
      ? 'agcod-v2.amazon.com' 
      : 'agcod-v2-gamma.amazon.com',
    method: 'POST',
    path: '/',
    headers: {
      'X-Amz-Target': 'com.amazonaws.agcod.AGCODService.CreateGiftCard',
      'Content-Type': 'application/x-amz-json-1.1'
    },
    body: JSON.stringify(payload)
  };

  // ← AWS4 firma automáticamente
  AWS4.sign(request, {
    accessKeyId: process.env.AMAZON_ACCESS_KEY,
    secretAccessKey: process.env.AMAZON_SECRET_KEY
  });

  // Hacer request a Amazon
  const response = await axios.post(
    `https://${request.host}${request.path}`,
    request.body,
    { headers: request.headers }
  );

  return response.data;
}

async function getAvailableFunds() {
  // Similar a createGiftCard, pero para GetAvailableFunds
  const request = {
    host: process.env.AMAZON_ENV === 'production' 
      ? 'agcod-v2.amazon.com' 
      : 'agcod-v2-gamma.amazon.com',
    method: 'POST',
    path: '/',
    headers: {
      'X-Amz-Target': 'com.amazonaws.agcod.AGCODService.GetAvailableFunds',
      'Content-Type': 'application/x-amz-json-1.1'
    },
    body: JSON.stringify({
      partnerId: process.env.AMAZON_PARTNER_ID
    })
  };

  AWS4.sign(request, {
    accessKeyId: process.env.AMAZON_ACCESS_KEY,
    secretAccessKey: process.env.AMAZON_SECRET_KEY
  });

  const response = await axios.post(
    `https://${request.host}${request.path}`,
    request.body,
    { headers: request.headers }
  );

  return response.data.availableFunds || 0;
}

module.exports = { createGiftCardWithRetries, getAvailableFunds };
```

- [ ] Crear tablas BigQuery: `gift_cards` + `access_logs` (1h)
- [ ] Implementar encriptación AES-256 (1h)
- [ ] Implementar endpoint `POST /gift-cards/process`: (6.5h)
  - Recibir llamada de Zoho (referidoId, contactId, contactEmail, contactName)
  - **Paso 1: Verificar si referido ya fue procesado** (30min)
    - Query BigQuery: `SELECT * FROM gift_cards WHERE referido_id = {referidoId}`
    - Si existe → Ir a flujo de REENVÍO (paso 5)
    - Si NO existe → Ir a flujo de NUEVO (paso 2)
  - **Paso 2: Nuevo referido - Validar en Zoho CRM:** (1h)
    - ¿Contact tiene Invoice en estado "matriculado"?
    - ¿Referido tiene Invoice en estado "matriculado" hace >20 días?
    - Si falla: Registrar en `access_logs` con `action="validation_failed"` y retornar error
    - Si pasan: Continuar a generar código
  - **Paso 3: Nuevo referido - Verificar fondos en Amazon:** (45min)
    - Llamar GetAvailableFunds a Amazon (rate limit: 1 req/seg)
    - ¿Hay créditos disponibles para el monto de la gift card?
    - Si FALLA (F300 - Insufficient balance):
      - Registrar en `access_logs`: `action="amazon_error"`, `amazon_error_code="F300"`
      - **Enviar email a crm@acme-example.com:**
        - Asunto: `[ALERTA] Fondos insuficientes en Amazon Incentives API`
        - Cuerpo: referido_id, contacto, monto solicitado, saldo disponible, timestamp
        - Acción: "Recargar fondos en Amazon Seller Central"
      - NO reintentar
      - Retornar error a Zoho: `Gift_Card_Email_Status = "Error: Fondos insuficientes"`
    - Si pasa: Continuar
  - **Paso 4: Nuevo referido - Generar código con reintentos:** (2h)
    - Generar `creationRequestId` único (UUID)
    - Implementar firma AWS Signature V4
    - Llamar CreateGiftCard con reintentos:
      - Max 3 intentos para F400 (backoff exponencial: 100ms, 200ms, 400ms)
      - Throttled: esperar 1-2 seg y reintentar
      - F100, F200, F300, F500: no reintentar, registrar y alertar
    - Si éxito: obtener `gcClaimCode`
    - Encriptar AES-256 inmediatamente
    - Guardar en `gift_cards` con `creation_request_id` ÚNICO
    - Registrar en `access_logs`: `action="generated"` O `action="amazon_error"` si falló
    - Si falló: retornar error sin continuar a email
    - Si éxito: continuar
  - **Paso 5: Email (nuevo o reenvío):**
    - Desencriptar código (solo en memoria)
    - Registrar en `access_logs` con `action="sent"` o `action="resent"`
    - Enviar email vía SendGrid
    - Actualizar `sendgrid_message_id`, `email_resent_count` (si reenvío), `email_last_resent_at` (si reenvío)
    - Retornar `{success: true, status: "generated|resent", sendgridMessageId}`
- [ ] Implementar endpoint `POST /gift-cards/resend`: (1h)
  - Buscar email original en BigQuery tabla `gift_cards` (ignorar email de Zoho)
  - Desencriptar código (solo en memoria)
  - Reenviar por SendGrid
  - Actualizar: `sendgrid_message_id`, `email_resent_count`, `email_last_resent_at`
  - Registrar en `access_logs` con action="resent"
  - **Nota:** Este endpoint es para reenvíos manuales desde botón CRM. El scheduler usa `/gift-cards/process` que ya maneja automáticamente si es nuevo o reenvío.
- [ ] Implementar `GET /health` (30min)
- [ ] Configurar logging con máxima seguridad: (1.5h)
  - ❌ NUNCA loguear el código desencriptado en ningún punto
  - ❌ NUNCA loguear variables de entorno con credenciales
  - ❌ NUNCA usar console.log() con datos sensibles (solo en desarrollo local)
  - ✅ Loguear: acciones (generated, sent, resent, bounced, validation_failed)
  - ✅ Loguear: IPs, timestamps, IDs de usuario, IDs de SendGrid
  - ✅ Loguear: errores generales (sin detalles del código)
  - Implementar: función `sanitizeLogs()` que remove códigos antes de enviar a Cloud Logging
  - Test: verificar que Cloud Logging nunca contiene el código en texto plano

**Entregable:** API funcional en entorno de desarrollo

---

### Semana 3: 2-6 junio (Lunes-Viernes) — SendGrid + Deploy en producción + CRM Integration

**Responsable: Developer**

**Lunes 2 - Miércoles 4: SendGrid + Deploy GCP**
- [ ] Crear plantilla de email en SendGrid (2h)
- [ ] Integrar plantilla con variables dinámicas: `nombre`, `amazonCode` (1h)
- [ ] Deploy en Google Cloud Run (2h)
  - Build imagen Docker
  - Configurar variables de entorno en Cloud Run
  - Verificar HTTPS automático
  - Testear endpoint desde postman/curl
- [ ] Configurar Cloud Logging e IAM (2h):
  - Activar Cloud Logging en Cloud Run
  - Crear rol "Gift Cards Auditor" (solo lectura)
  - Asignar rol a IT/compliance/dirección de ACME
  - Verificar que solo ellos ven los logs
  - Configurar retención de logs: mínimo 1 año
- [ ] Configurar alertas automáticas (1h):
  - Alert: >3 errores Amazon en 1 hora
  - Alert: Acceso a gift_cards desde IP inesperada
  - Alert: Fondos insuficientes (F300)

**Jueves 5 - Viernes 6: Integración Zoho CRM**
- [ ] Crear campos en módulo Referidos (1h):
  - `Gift_Card_Enviada` (checkbox)
  - `Gift_Card_Enviada_Fecha` (datetime)
  - `Gift_Card_SendGrid_ID` (string)
  - `Gift_Card_Email_Status` (dropdown: Pendiente, Enviado, Rebotado, Abierto)
  - `Gift_Card_Reenvios` (number)
  - `Gift_Card_Ultimo_Reenvio` (datetime)
- [ ] Crear Scheduler Deluge diario (2h):
  - Buscar referidos con 20+ días sin código
  - Llamar POST /gift-cards/process en endpoint producción
  - Manejar respuestas (success/error)
  - Registrar resultado en access_logs
- [ ] Crear Custom Button "Relanzar Gift Card" (1.5h):
  - Visible solo si Gift_Card_Enviada = true
  - Llama POST /gift-cards/resend
  - Actualiza Gift_Card_Ultimo_Reenvio y Gift_Card_Reenvios
- [ ] Probar toda la cadena Zoho → API → BigQuery (1h):
  - Crear referido de prueba
  - Ejecutar scheduler manualmente
  - Verificar datos en BigQuery
  - Verificar email recibido

**Entregable:** API en producción, CRM integrado, ACME con acceso a logs

---

### Semana 4: 9-10 junio (Lunes-Martes) — Testing final + Go live

**Responsable: Developer + alguien de marketing/soporte para UX del email**

**Lunes 9: Testing en sandbox**
- [ ] Crear 3-5 registros de prueba en Referidos con fecha de matrícula hace 21 días (30min)
- [ ] **Test 1: Flujo nuevo completo (30min + 1.5h)**
  - Ejecutar scheduler manualmente
  - Verificar: código generado, guardado ENCRIPTADO en BigQuery, email enviado
  - ✅ regalo_id ÚNICO en tabla
  - ✅ amazon_code_encrypted en BASE64 (no legible)
  - ✅ access_logs registra "generated"
  - ✅ Zoho CRM: Gift_Card_Enviada=true, sin rastro del código
  
- [ ] **Test 2: Reenvío automático (30min)**
  - Ejecutar scheduler de nuevo (mismo referido)
  - Verificar: API reutiliza código existente, NO llama a Amazon
  - ✅ email_resent_count incrementado
  - ✅ access_logs registra "resent"
  
- [ ] **Test 3: Validaciones fallidas (30min)**
  - Crear referido con <20 días → scheduler no envía
  - Crear sin invoice en Zoho → scheduler no envía
  - Verificar: access_logs registra "validation_failed"
  
- [ ] **Test 4: Seguridad de código en logs (1h)**
  - Buscar código en Cloud Logging → ❌ NO debe aparecer
  - Buscar código en access_logs → ❌ NO debe aparecer
  - Verificar código ENCRIPTADO en gift_cards → ✅
  - Probar botón "Relanzar Gift Card" → funciona

- [ ] **Test 5: Errores Amazon (1h)**
  - Simular F400 (reintenta 3x) ✅
  - Simular F300 (fondos insuficientes → email a crm@) ✅
  - Verificar idempotencia (creationRequestId duplicado) ✅

**Martes 10: Go live**
- [ ] Cambiar AMAZON_ENV=sandbox → AMAZON_ENV=production (15min)
- [ ] Hacer 2-3 pruebas reales con bajo monto ($5 máximo) (1h)
- [ ] Verificar cadena completa en producción (30min)
- [ ] Documentación para soporte: endpoints, errores comunes, troubleshooting (1h)
- [ ] Entregar acceso Cloud Logging a ACME (30min)
- [ ] Briefing rápido al equipo (30min)

**Entregable:** ✅ Sistema en PRODUCCIÓN, ACME con acceso, equipo capacitado

---


## Resumen ejecutivo: 4 Semanas (22 mayo - 10 junio 2026)

**Fecha de inicio:** Jueves 22 de mayo 2026
**Fecha fin:** Martes 10 de junio 2026
**Duración:** 20 días calendario = 14 días hábiles
**Dedicación:** 40 horas/semana (8h/día, lunes-viernes)
**Horas disponibles:** 112 horas
**Horas requeridas:** ~54 horas
**Margen:** 58 horas (debugging, reuniones, bloqueos)

---

### Desglose por semana

| Semana | Período | Días hábiles | Fase | Horas | Entregable |
|---|---|---|---|---|---|
| **1** | 22-23 mayo (J-V) | 2 | Setup + Validaciones | 10h | Entorno listo, credenciales OK, BD operativa |
| **2** | 26-30 mayo (L-V) | 5 | Desarrollo API core | 24h | API funcional en desarrollo, endpoints listos |
| **3** | 2-6 junio (L-V) | 5 | Deploy + CRM | 12h | API en producción, CRM integrado, ACME con acceso |
| **4** | 9-10 junio (L-M) | 2 | Testing + Go live | 8h | ✅ SISTEMA EN PRODUCCIÓN |
| **TOTAL** | | **14 días** | | **~54h** | **Go live 10 junio** |

---

### Horas por componente

| Componente | Horas | Semana |
|---|---|---|
| **Semana 1: Setup** | | |
| ├─ NTP (crítico) | 0.5h | 1 |
| ├─ BigQuery schema + credenciales | 2h | 1 |
| ├─ Variables de entorno | 1h | 1 |
| ├─ Repo GitHub + GCP project | 1h | 1 |
| ├─ Reuniones con equipos | 4.5h | 1 |
| **Semana 2: API Node.js** | | |
| ├─ Estructura Express | 1.5h | 2 |
| ├─ AWS Signature V4 (aws4) | 1.5h | 2 |
| ├─ BigQuery client + Encriptación | 2h | 2 |
| ├─ Endpoint /gift-cards/process | 8.5h | 2 |
| ├─ Endpoint /gift-cards/resend | 1h | 2 |
| ├─ Logging seguro + sanitizer | 3h | 2 |
| ├─ Cloud Logging setup | 2.5h | 2 |
| ├─ Tests unitarios | 4h | 2 |
| **Semana 3: Deploy + CRM** | | |
| ├─ Plantilla SendGrid | 2h | 3 |
| ├─ Integración SendGrid con API | 2h | 3 |
| ├─ Deploy Cloud Run | 2h | 3 |
| ├─ IAM + rol "Gift Cards Auditor" | 2h | 3 |
| ├─ Alertas automáticas | 1h | 3 |
| ├─ Campos en módulo Referidos | 1h | 3 |
| ├─ Scheduler Deluge 20+ días | 2h | 3 |
| ├─ Custom Button "Relanzar" | 1.5h | 3 |
| ├─ Test integración Zoho → API | 1h | 3 |
| **Semana 4: Testing + Go live** | | |
| ├─ Test 1: Flujo nuevo | 2h | 4 |
| ├─ Test 2: Reenvío automático | 0.5h | 4 |
| ├─ Test 3: Validaciones | 0.5h | 4 |
| ├─ Test 4: Seguridad en logs | 1h | 4 |
| ├─ Test 5: Errores Amazon | 1h | 4 |
| ├─ Go live | 1h | 4 |
| ├─ Documentación + Briefing | 2h | 4 |
| | | |
| **TOTAL HORAS** | **~54h** | |

---

### Calendario visual

```
MAYO 2026
L  M  M  J  V  S  D
            22 23 24 25 26       ← Semana 1: Setup (J-V)
27 28 29 30 31
                                ← Fin de semana

JUNIO 2026
L  M  M  J  V  S  D
2  3  4  5  6  7  8             ← Semana 2: API Dev (L-V)
9  10 11 12 13 14 15            ← Semana 3: Deploy + CRM (L-V)
                                ← Semana 4: Testing + Go live (L-M: 9-10)
```

---

### Requisitos cumplidos

✅ Credenciales AWS/BigQuery/Amazon listas (proporcionadas)
✅ 20 días calendario máximo (22 mayo - 10 junio)
✅ 14 días hábiles (lunes-viernes)
✅ Dedicación 40h/semana
✅ Margen de 58 horas para impredvistos
✅ Arquitectura de seguridad inmutable (Cloud Logging no modificable)
✅ Acceso restringido a developers en BigQuery/GCP (solo ACME)
✅ Códigos NUNCA en texto plano en logs
