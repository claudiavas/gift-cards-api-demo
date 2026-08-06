/**
 * Logger - Sistema de logging seguro
 *
 * IMPORTANTE: Este logger NUNCA debe registrar:
 * - Códigos de tarjetas regalo (amazon codes)
 * - Claves AWS (AKIA...)
 * - Tokens de API (SendGrid, CRM, etc)
 * - Información de encriptación
 *
 * El sanitizer se encarga de limpiar logs antes de enviarlos a Cloud Logging
 */

const { sanitize } = require('../middleware/sanitizer');

class Logger {
  constructor(name = 'gift-cards-api') {
    this.name = name;
    this.timestamp = () => new Date().toISOString();
  }

  /**
   * Log nivel INFO - Para eventos normales del sistema
   * Ejemplo: "Código generado exitosamente", "Email enviado"
   */
  info(message, metadata = {}) {
    const logEntry = {
      timestamp: this.timestamp(),
      level: 'INFO',
      message: sanitize(message),
      ...metadata,
    };

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[${logEntry.timestamp}] INFO: ${message}`, metadata);
    }

    // AQUÍ: En producción, enviar a Cloud Logging
    // const logging = new logging.Logging({
    //   projectId: process.env.GOOGLE_PROJECT_ID,
    // });
    // logging.log(process.env.CLOUD_LOG_NAME).write(logEntry);

    return logEntry;
  }

  /**
   * Log nivel ERROR - Para errores que requieren atención
   * El mensaje de error se sanitiza antes de loguear
   */
  error(message, error = null, metadata = {}) {
    const sanitizedMessage = sanitize(message);
    const sanitizedError = error ? sanitize(error.message || error.toString()) : null;

    const logEntry = {
      timestamp: this.timestamp(),
      level: 'ERROR',
      message: sanitizedMessage,
      error: sanitizedError,
      stack: error?.stack || null,
      ...metadata,
    };

    if (process.env.NODE_ENV !== 'production') {
      console.error(`[${logEntry.timestamp}] ERROR: ${sanitizedMessage}`, {
        originalError: error?.message,
        ...metadata
      });
    }

    // AQUÍ: En producción, enviar a Cloud Logging
    // const logging = new logging.Logging({
    //   projectId: process.env.GOOGLE_PROJECT_ID,
    // });
    // logging.log(process.env.CLOUD_LOG_NAME).write(logEntry);

    return logEntry;
  }

  /**
   * Log nivel WARN - Para situaciones inesperadas pero no críticas
   */
  warn(message, metadata = {}) {
    const logEntry = {
      timestamp: this.timestamp(),
      level: 'WARN',
      message: sanitize(message),
      ...metadata,
    };

    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[${logEntry.timestamp}] WARN: ${message}`, metadata);
    }

    return logEntry;
  }

  /**
   * Log nivel DEBUG - Solo en desarrollo
   * Datos detallados para debugging
   */
  debug(message, metadata = {}) {
    if (process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development') {
      const logEntry = {
        timestamp: this.timestamp(),
        level: 'DEBUG',
        message: sanitize(message),
        ...metadata,
      };

      console.log(`[${logEntry.timestamp}] DEBUG: ${message}`, metadata);
      return logEntry;
    }
  }

  /**
   * Log estructurado para auditoría
   * Se usa para registrar acciones críticas que deben auditarse
   * NOTA: No incluir códigos en plaintext - solo IDs y metadata
   */
  audit(action, giftCardId, metadata = {}) {
    const auditEntry = {
      timestamp: this.timestamp(),
      level: 'AUDIT',
      action: action, // "generated", "sent", "resent", "validation_failed", "amazon_error"
      gift_card_id: giftCardId, // ID de la tarjeta (NO el código)
      ...metadata,
    };

    console.log(`[${auditEntry.timestamp}] AUDIT: ${action} - GiftCard: ${giftCardId}`, metadata);

    // AQUÍ: Guardar en BigQuery tabla access_logs
    // await bigquery.table('access_logs').insert(auditEntry);

    return auditEntry;
  }
}

// Exportar instancia singleton
module.exports = new Logger(process.env.APP_NAME || 'gift-cards-api');
