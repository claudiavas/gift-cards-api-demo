/**
 * Sanitizer Middleware - Remover datos sensibles de logs
 *
 * Este módulo es CRÍTICO para la seguridad:
 * - Remueve códigos de tarjetas regalo
 * - Remueve claves AWS
 * - Remueve tokens de API
 * - Remueve información de encriptación
 *
 * Se ejecuta ANTES de que cualquier dato llegue a los logs
 */

/**
 * Patrones regex para identificar datos sensibles
 * Cada patrón intenta identificar un tipo específico de credencial/dato sensible
 */
const sensitivePatterns = [
  // Códigos de tarjeta regalo Amazon (formato: ABCD-EFGH-IJKL-MNOP)
  {
    name: 'amazon_code',
    pattern: /[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g,
    replacement: '[REDACTED_AMAZON_CODE]'
  },

  // AWS Access Keys (formato: AKIA...)
  {
    name: 'aws_access_key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED_AWS_KEY]'
  },

  // AWS Secret Keys (formato: largo y con caracteres especiales)
  {
    name: 'aws_secret_key',
    pattern: /aws_secret_access_key["\s]*[:=]["\s]*[A-Za-z0-9/+=]{40,}/gi,
    replacement: '[REDACTED_AWS_SECRET]'
  },

  // SendGrid API Keys (formato: SG....)
  {
    name: 'sendgrid_key',
    pattern: /SG\.[a-zA-Z0-9_-]{60,}/g,
    replacement: '[REDACTED_SENDGRID_KEY]'
  },

  // Google Cloud API Keys
  {
    name: 'gcp_api_key',
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
    replacement: '[REDACTED_GCP_KEY]'
  },

  // Tokens OAuth genéricos (long strings que parecen tokens)
  {
    name: 'oauth_token',
    pattern: /bearer\s+[a-zA-Z0-9._-]{50,}/gi,
    replacement: '[REDACTED_TOKEN]'
  },

  // Emails (para cierto nivel de privacidad)
  {
    name: 'email_sensitive',
    pattern: /[\w.-]+@[\w.-]+\.\w+/g,
    replacement: '[REDACTED_EMAIL]'
  },

  // Direcciones IP (para evitar exposición de IPs internas)
  {
    name: 'internal_ip',
    pattern: /\b(10\.|172\.|192\.)\d+\.\d+\.\d+\b/g,
    replacement: '[REDACTED_IP]'
  },
];

/**
 * Función principal de sanitización
 * @param {string} input - Texto a limpiar
 * @returns {string} Texto limpio sin datos sensibles
 */
function sanitize(input) {
  // Si no es string, convertir a string
  if (!input || typeof input !== 'string') {
    return String(input);
  }

  let sanitized = input;

  // Aplicar cada patrón de sanitización
  sensitivePatterns.forEach(({ pattern, replacement }) => {
    sanitized = sanitized.replace(pattern, replacement);
  });

  return sanitized;
}

/**
 * Middleware de Express para sanitizar todos los logs
 * Se coloca al inicio de la cadena de middleware
 */
function sanitizerMiddleware(req, res, next) {
  // Guardar el console.log original
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;

  // Interceptar todos los console logs
  console.log = function(...args) {
    const sanitizedArgs = args.map(arg => {
      if (typeof arg === 'string') {
        return sanitize(arg);
      }
      if (typeof arg === 'object') {
        return JSON.parse(sanitize(JSON.stringify(arg)));
      }
      return arg;
    });
    originalLog(...sanitizedArgs);
  };

  console.error = function(...args) {
    const sanitizedArgs = args.map(arg => {
      if (typeof arg === 'string') {
        return sanitize(arg);
      }
      return arg;
    });
    originalError(...sanitizedArgs);
  };

  console.warn = function(...args) {
    const sanitizedArgs = args.map(arg => {
      if (typeof arg === 'string') {
        return sanitize(arg);
      }
      return arg;
    });
    originalWarn(...sanitizedArgs);
  };

  // Restaurar console functions al final del request
  res.on('finish', () => {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  });

  next();
}

/**
 * Exportar funciones
 */
module.exports = {
  sanitize,
  sanitizerMiddleware,
};
