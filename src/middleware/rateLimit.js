/**
 * Rate Limiting Middleware
 *
 * Implementa límites de tasa para evitar:
 * - Abuso del endpoint /gift-cards/process
 * - Demasiados reenvíos en corto tiempo
 * - DoS attacks
 *
 * Límites:
 * - POST /gift-cards/process: 100 requests/hora por API key
 * - POST /gift-cards/resend: 5 reenvíos máximo por regalo
 */

const logger = require('../utils/logger');

/**
 * Store en memoria para rate limits
 * En producción, usar Redis
 * Estructura: { key: { timestamp: count, ... } }
 */
const rateLimitStore = {};

/**
 * Middleware de rate limiting genérico
 *
 * @param {number} maxRequests - Máximo de requests permitidos
 * @param {number} windowMs - Ventana de tiempo en ms (ej: 3600000 = 1 hora)
 * @param {string} keyGenerator - Función para generar clave (ej: req => req.headers['x-api-key'])
 */
function createRateLimiter(maxRequests, windowMs, keyGenerator = req => req.ip) {
  return (req, res, next) => {
    try {
      const key = keyGenerator(req);
      const now = Date.now();

      // Inicializar store si no existe
      if (!rateLimitStore[key]) {
        rateLimitStore[key] = [];
      }

      // Limpiar requests fuera de la ventana
      rateLimitStore[key] = rateLimitStore[key].filter(timestamp => now - timestamp < windowMs);

      // Verificar si se alcanzó el límite
      if (rateLimitStore[key].length >= maxRequests) {
        logger.warn('Rate limit exceeded', {
          key: key.substring(0, 10) + '...', // No loguear clave completa
          method: req.method,
          path: req.path,
          requests: rateLimitStore[key].length,
          limit: maxRequests,
        });

        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Maximum ${maxRequests} requests per ${(windowMs / 60000).toFixed(0)} minutes`,
          retryAfter: (windowMs / 1000).toFixed(0),
        });
      }

      // Agregar nuevo request
      rateLimitStore[key].push(now);

      // Agregar headers informativos
      res.set('X-RateLimit-Limit', maxRequests);
      res.set('X-RateLimit-Remaining', maxRequests - rateLimitStore[key].length);
      res.set('X-RateLimit-Reset', new Date(now + windowMs).toISOString());

      next();
    } catch (error) {
      logger.error('Rate limit middleware error', error);
      // No bloquear si hay error en el middleware
      next();
    }
  };
}

/**
 * Rate limiter para POST /gift-cards/process
 * Máximo 100 generaciones por hora por API key
 */
const processRateLimiter = createRateLimiter(
  100, // maxRequests
  3600000, // 1 hora
  req => req.headers['x-api-key'] || req.ip
);

/**
 * Rate limiter para POST /gift-cards/resend
 * Máximo 50 reenvíos por hora (por tarjeta, máx 5 totales)
 */
const resendRateLimiter = createRateLimiter(
  50, // maxRequests
  3600000, // 1 hora
  req => `${req.headers['x-api-key']}-${req.body?.giftCardId || req.ip}`
);

/**
 * Validar límite específico de reenvíos para un regalo
 * Máximo: 1 por hora, 3 por día, 5 en total
 *
 * @param {Array<TIMESTAMP>} resendDates - Array de timestamps de reenvíos anteriores
 * @returns {object} { allowed: boolean, reason: string, remaining: number }
 */
function checkResendLimit(resendDates = []) {
  const now = new Date();
  const oneHourAgo = new Date(now - 60 * 60 * 1000);
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);

  // Convertir timestamps a Date si están en string
  const dates = resendDates.map(d => new Date(d));

  // Contar reenvíos en diferentes ventanas
  const resends1H = dates.filter(d => d > oneHourAgo).length;
  const resends1D = dates.filter(d => d > oneDayAgo).length;
  const resends_total = dates.length;

  // Validaciones
  if (resends_total >= 5) {
    return {
      allowed: false,
      reason: 'Max 5 total resends reached',
      remaining: 0,
    };
  }

  if (resends1D >= 3) {
    return {
      allowed: false,
      reason: 'Max 3 resends per day reached',
      remaining: 0,
    };
  }

  if (resends1H >= 1) {
    return {
      allowed: false,
      reason: 'Only 1 resend per hour allowed',
      nextAllowed: new Date(dates[dates.length - 1] + 60 * 60 * 1000),
      remaining: 0,
    };
  }

  // Calcular cuántos quedan
  const remainingTotal = 5 - resends_total;
  const remainingDay = 3 - resends1D;
  const remainingHour = 1 - resends1H;

  return {
    allowed: true,
    remaining: Math.min(remainingTotal, remainingDay, remainingHour),
    limits: {
      hour: remainingHour,
      day: remainingDay,
      total: remainingTotal,
    },
  };
}

/**
 * Limpiar store en memoria (para no crecer infinitamente)
 * Ejecutar cada 10 minutos
 */
setInterval(() => {
  const now = Date.now();
  for (const key in rateLimitStore) {
    rateLimitStore[key] = rateLimitStore[key].filter(timestamp => now - timestamp < 3600000);
    if (rateLimitStore[key].length === 0) {
      delete rateLimitStore[key];
    }
  }
}, 10 * 60 * 1000).unref();

module.exports = {
  createRateLimiter,
  processRateLimiter,
  resendRateLimiter,
  checkResendLimit,
};
