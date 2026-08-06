-- ============================================================================
-- PostgreSQL Schema para Gift Cards API
-- ============================================================================
-- La aplicación crea este esquema automáticamente al arrancar
-- (src/services/db.js). Este script existe como referencia y para
-- provisionar la base a mano si se prefiere.
--
-- Los UNIQUE son la pieza central del diseño: la idempotencia la garantiza
-- la base de datos, no la aplicación. Dos requests concurrentes con el mismo
-- reward_id no pueden generar (ni pagar) dos tarjetas.
-- ============================================================================

-- ============================================================================
-- Tabla 1: gift_cards
-- Almacena códigos de tarjetas regalo SIEMPRE encriptados (AES-256-GCM)
-- ============================================================================
CREATE TABLE IF NOT EXISTS gift_cards (
  -- Identificadores
  id UUID PRIMARY KEY,                              -- UUID único de la tarjeta
  reward_id TEXT NOT NULL UNIQUE,                   -- ID externo de la recompensa (una tarjeta por reward)

  -- Información del destinatario
  contact_email TEXT NOT NULL,                      -- Email del destinatario (inmutable)

  -- Código encriptado (NUNCA en plaintext)
  amazon_code_encrypted TEXT NOT NULL,              -- Código AES-256-GCM en base64

  -- Metadata de Amazon
  amazon_creation_request_id TEXT NOT NULL UNIQUE,  -- UUID de idempotencia contra Amazon
  amazon_currency_code TEXT DEFAULT 'USD',
  amazon_amount INTEGER,                            -- Monto en unidades menores (5000 = 50.00)

  -- Estado del email
  sendgrid_message_id TEXT,
  email_sent BOOLEAN NOT NULL DEFAULT false,
  email_sent_at TIMESTAMPTZ,
  email_resent_count INTEGER NOT NULL DEFAULT 0,    -- Máx 5 reenvíos en total
  email_last_resent_at TIMESTAMPTZ,
  email_status TEXT DEFAULT 'pending',              -- pending, sent, resent, bounced...

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Tabla 2: access_logs
-- Auditoría append-only: qué pasó con cada tarjeta, quién y desde dónde
-- ============================================================================
CREATE TABLE IF NOT EXISTS access_logs (
  id UUID PRIMARY KEY,
  gift_card_id TEXT,                                -- Referencia a gift_cards.id
  action TEXT NOT NULL,                             -- generated, sent, resent, validation_failed, amazon_error
  performed_by TEXT,                                -- scheduler, api, agente concreto, system
  source_ip TEXT,
  failure_reason TEXT,
  amazon_error_code TEXT,                           -- F100, F200, F300, F400, F500
  amazon_error_msg TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Roles (producción): la auditoría es inmutable por permisos
-- ============================================================================
-- El rol de la aplicación solo puede INSERTAR en el log de auditoría;
-- ni siquiera el desarrollador puede reescribir la historia.
--
--   REVOKE UPDATE, DELETE, TRUNCATE ON access_logs FROM app_role;
--   GRANT INSERT ON access_logs TO app_role;
--
-- El rol auditor solo puede LEER:
--
--   GRANT SELECT ON gift_cards, access_logs TO auditor_role;
