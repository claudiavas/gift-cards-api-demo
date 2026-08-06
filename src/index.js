/**
 * Gift Cards API - Servidor Express principal
 *
 * Punto de entrada de la aplicación
 * - Inicializa Express
 * - Carga middleware de seguridad
 * - Configura rutas
 * - Maneja errores
 *
 * SEGURIDAD:
 * - Todas las solicitudes requieren API_KEY en header
 * - Sanitizer se ejecuta al principio para limpiar logs
 * - Errores no exponen detalles internos
 */

require('dotenv').config();

// DEMO_MODE: despliegue público sin credenciales reales
// - API key de demostración conocida (la página de demo la usa)
// - Clave de encriptación efímera por arranque (el almacén es en memoria)
const DEMO_MODE = process.env.DEMO_MODE === 'true';
if (DEMO_MODE) {
  process.env.API_KEY = process.env.API_KEY || 'demo-api-key-2026';
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('base64');
}

const express = require('express');
const path = require('path');
const logger = require('./utils/logger');
const { sanitizerMiddleware } = require('./middleware/sanitizer');

// Validaciones previas
if (!process.env.API_KEY) {
  console.error('❌ API_KEY no está definida en .env');
  process.exit(1);
}

if (!process.env.ENCRYPTION_KEY) {
  console.error('❌ ENCRYPTION_KEY no está definida en .env');
  process.exit(1);
}

/**
 * Inicializar aplicación Express
 */
const app = express();

/**
 * MIDDLEWARE - Orden importa
 * 1. Sanitizer (primero, para limpiar logs)
 * 2. JSON parser
 * 3. Autenticación
 * 4. Logging
 * 5. Rutas
 * 6. Error handling
 */

// 1. Sanitizer middleware - ejecutar PRIMERO
app.use(sanitizerMiddleware);

// 2. Parsear JSON
app.use(express.json({ limit: '1mb' }));

// 3. Middleware de autenticación
/**
 * Validar que todas las solicitudes tengan API_KEY en header
 * Header esperado: x-api-key: {API_KEY}
 */
app.use((req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  // Health check se permite sin auth (importante para Cloud Run)
  if (req.path === '/health') {
    return next();
  }

  // Página de demostración y su configuración: públicas
  if (req.method === 'GET' && !req.path.startsWith('/gift-cards')) {
    return next();
  }

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid x-api-key header',
    });
  }

  next();
});

// 4. Middleware de logging de requests
app.use((req, res, next) => {
  const startTime = Date.now();

  // Registrar request (sin cuerpo sensible)
  logger.debug(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });

  // Interceptar response para loguear duración
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.debug(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });

  next();
});

/**
 * RUTAS
 */

// Health check - para verificar que el servidor está arriba
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    version: process.env.API_VERSION || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString(),
  });
});

// Configuración para la página de demo (solo expone datos en DEMO_MODE)
app.get('/demo-config', (req, res) => {
  res.status(200).json({
    demoMode: DEMO_MODE,
    // La API key de demo es pública a propósito: permite probar la autenticación
    apiKey: DEMO_MODE ? process.env.API_KEY : null,
  });
});

// Rutas de gift cards
const giftCardsRouter = require('./routes/giftCards');
app.use('/gift-cards', giftCardsRouter);

// Página de demostración interactiva
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * 404 - Ruta no encontrada
 */
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Endpoint ${req.method} ${req.path} no existe`,
  });
});

/**
 * ERROR HANDLING - Middleware final
 *
 * IMPORTANTE: NUNCA retornar detalles de error al cliente
 * El error real se loguea, pero la respuesta es genérica
 */
app.use((error, req, res, next) => {
  logger.error('Unhandled error', error, {
    path: req.path,
    method: req.method,
    ip: req.ip,
  });

  // Respuesta genérica (sin exponer detalles internos)
  res.status(error.status || 500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred',
  });
});

/**
 * INICIAR SERVIDOR
 */
const PORT = process.env.PORT || process.env.API_PORT || 3000;

const server = app.listen(PORT, () => {
  logger.info(`🚀 Gift Cards API iniciada`, {
    port: PORT,
    environment: process.env.NODE_ENV,
    demoMode: DEMO_MODE,
    debug: process.env.DEBUG === 'true',
  });
});

/**
 * MANEJO DE SEÑALES PARA GRACEFUL SHUTDOWN
 * Permite que las solicitudes terminen antes de cerrar
 */
process.on('SIGTERM', () => {
  logger.warn('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.warn('SIGINT signal received: closing HTTP server');
  process.exit(0);
});

module.exports = app;
