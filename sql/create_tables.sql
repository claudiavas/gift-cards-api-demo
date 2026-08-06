-- ============================================================================
-- BigQuery Schema para Gift Cards API
-- ============================================================================
-- Ejecutar este script en Google Cloud Console para crear las tablas
--
-- Pasos:
-- 1. Ir a BigQuery Console: https://console.cloud.google.com/bigquery
-- 2. Seleccionar tu dataset
-- 3. Click "Create Table" → "SQL"
-- 4. Copiar y pegar cada CREATE TABLE
-- ============================================================================

-- ============================================================================
-- Tabla 1: gift_cards
-- Almacena códigos de tarjetas regalo encriptados
-- ============================================================================
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET_ID.gift_cards` (
  -- Identificadores
  id STRING NOT NULL DESCRIPTION "UUID único de la tarjeta",
  referido_id STRING NOT NULL DESCRIPTION "ID del módulo Referidos en Zoho (ÚNICO - una tarjeta por referido)",

  -- Información del destinatario
  contact_email STRING NOT NULL DESCRIPTION "Email del alumno (inmutable - no cambiar después)",
  contact_name STRING DESCRIPTION "Nombre del alumno",

  -- Código encriptado (NUNCA en plaintext)
  amazon_code_encrypted STRING NOT NULL DESCRIPTION "Código Amazon encriptado con AES-256 (base64)",

  -- Metadata de Amazon
  amazon_creation_request_id STRING NOT NULL DESCRIPTION "UUID único para idempotencia (ÚNICO - evita duplicados)",
  amazon_currency_code STRING DESCRIPTION "Moneda: USD, EUR, JPY, CAD, AUD, TRY, AED",
  amazon_amount INT64 DESCRIPTION "Monto en unidades menores (ej: 5000 = $50.00)",
  amazon_redeemed_at TIMESTAMP DESCRIPTION "Cuándo se canjeó la tarjeta (se actualiza manualmente desde Amazon Dashboard)",
  amazon_redeemed_ip STRING DESCRIPTION "IP desde donde se canjeó",

  -- Metadata de SendGrid (email)
  sendgrid_message_id STRING DESCRIPTION "ID del mensaje en SendGrid para seguimiento",
  email_sent BOOL NOT NULL DEFAULT FALSE DESCRIPTION "¿Se envió el email?",
  email_sent_at TIMESTAMP DESCRIPTION "Cuándo se envió el primer email",
  email_resent_count INT64 DEFAULT 0 DESCRIPTION "Cuántos reenvíos (máx 5 totales)",
  email_resent_dates ARRAY<TIMESTAMP> DESCRIPTION "Timestamps de cada reenvío",
  email_last_resent_at TIMESTAMP DESCRIPTION "Timestamp del último reenvío",
  email_status STRING DESCRIPTION "Estado: pending, sent, resent, bounced, opened, complained",
  bounce_reason_es STRING DESCRIPTION "Motivo de rechazo en español (si bounced)",
  email_template STRING DESCRIPTION "ID de la plantilla de SendGrid usada",

  -- Timestamps de auditoría
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP() DESCRIPTION "Cuándo se creó el registro",
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP() DESCRIPTION "Última actualización"
);

-- Constraints (comentados porque BigQuery no soporta en CREATE TABLE)
-- CONSTRAINT referido_id_unique UNIQUE (referido_id)
-- CONSTRAINT creation_request_id_unique UNIQUE (amazon_creation_request_id)

-- ============================================================================
-- Tabla 2: access_logs
-- Auditoría inmutable de TODOS los accesos a códigos
-- No se puede editar, solo leer (Cloud Logging controla acceso)
-- ============================================================================
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET_ID.access_logs` (
  -- Identificadores
  id STRING NOT NULL DESCRIPTION "UUID único del log",
  gift_card_id STRING DESCRIPTION "Referencia a gift_cards.id (qué tarjeta se accedió)",

  -- Acción realizada
  action STRING NOT NULL DESCRIPTION "validation_failed, amazon_error, generated, sent, resent, bounced, decrypted, accessed",

  -- Quién y desde dónde
  performed_by STRING DESCRIPTION "scheduler, claudia.vasquez.as@gmail.com, system",
  source_ip STRING DESCRIPTION "IP desde donde se hizo la acción",

  -- Detalles del error (si aplica)
  failure_reason STRING DESCRIPTION "Por qué falló (ej: 'contact_not_matriculated', 'insufficient_funds')",
  amazon_error_code STRING DESCRIPTION "Código de error Amazon: F100, F200, F300, F400, F500, Throttled",
  amazon_error_msg STRING DESCRIPTION "Mensaje de error de Amazon",

  -- Metadata adicional
  metadata JSON DESCRIPTION "Datos adicionales en JSON (flexible para logs futuros)",

  -- Auditoría del log
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP() DESCRIPTION "Timestamp inmutable del evento"
);

-- ============================================================================
-- Índices para performance
-- ============================================================================
-- BigQuery no requiere índices tradicionales, pero podemos crear tabla clustered

CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET_ID.gift_cards_clustered` (
  id STRING NOT NULL,
  referido_id STRING NOT NULL,
  contact_email STRING NOT NULL,
  amazon_code_encrypted STRING NOT NULL,
  amazon_creation_request_id STRING NOT NULL,
  amazon_currency_code STRING,
  amazon_amount INT64,
  amazon_redeemed_at TIMESTAMP,
  sendgrid_message_id STRING,
  email_sent BOOL NOT NULL DEFAULT FALSE,
  email_sent_at TIMESTAMP,
  email_resent_count INT64 DEFAULT 0,
  email_resent_dates ARRAY<TIMESTAMP>,
  email_last_resent_at TIMESTAMP,
  email_status STRING,
  bounce_reason_es STRING,
  email_template STRING,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY referido_id, created_at;

-- ============================================================================
-- Tabla de cambios (Change Data Capture)
-- Para auditoría de qué cambió en gift_cards
-- ============================================================================
CREATE TABLE IF NOT EXISTS `PROJECT_ID.DATASET_ID.gift_cards_changes` (
  change_id STRING NOT NULL DESCRIPTION "UUID único del cambio",
  gift_card_id STRING NOT NULL DESCRIPTION "Qué regalo cambió",
  change_type STRING NOT NULL DESCRIPTION "INSERT, UPDATE, DELETE",
  changed_fields ARRAY<STRING> DESCRIPTION "Qué campos cambiaron",
  old_values JSON DESCRIPTION "Valores anteriores",
  new_values JSON DESCRIPTION "Valores nuevos",
  changed_by STRING DESCRIPTION "Quién hizo el cambio",
  changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP() DESCRIPTION "Cuándo"
);

-- ============================================================================
-- Vistas útiles para análisis y reporting
-- ============================================================================

-- Vista: Tarjetas sin enviar después de 24h
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET_ID.unsent_cards` AS
SELECT
  id,
  referido_id,
  contact_email,
  created_at,
  TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), created_at, HOUR) as hours_since_creation
FROM `PROJECT_ID.DATASET_ID.gift_cards`
WHERE email_sent = FALSE
  AND TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), created_at, HOUR) > 24
ORDER BY created_at DESC;

-- Vista: Tarjetas con demasiados reenvíos
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET_ID.excessive_resends` AS
SELECT
  id,
  referido_id,
  contact_email,
  email_resent_count,
  email_last_resent_at,
  email_status
FROM `PROJECT_ID.DATASET_ID.gift_cards`
WHERE email_resent_count >= 4;

-- Vista: Errores por tipo
CREATE OR REPLACE VIEW `PROJECT_ID.DATASET_ID.error_summary` AS
SELECT
  action,
  amazon_error_code,
  COUNT(*) as count,
  MAX(created_at) as last_occurrence
FROM `PROJECT_ID.DATASET_ID.access_logs`
WHERE action IN ('validation_failed', 'amazon_error', 'bounced')
GROUP BY action, amazon_error_code
ORDER BY count DESC;

-- ============================================================================
-- IMPORTANTE: Reemplazar PROJECT_ID y DATASET_ID con valores reales
-- Ejemplo:
-- - PROJECT_ID: "my-gcp-project-123"
-- - DATASET_ID: "gift_cards_db"
-- ============================================================================
