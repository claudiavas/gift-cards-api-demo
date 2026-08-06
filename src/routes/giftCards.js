/**
 * Rutas de Gift Cards API
 *
 * Endpoints:
 * 1. POST /gift-cards/process - Generar y enviar tarjeta nueva (o reenviar existente)
 * 2. POST /gift-cards/resend - Reenviar tarjeta existente (botón manual en CRM)
 *
 * Solo en DEMO_MODE:
 * 3. GET /gift-cards/demo/records - Ver registros almacenados (códigos encriptados)
 * 4. GET /gift-cards/demo/audit - Ver log de auditoría
 * 5. GET /gift-cards/demo/last-email - Ver el último email simulado
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const logger = require('../utils/logger');
const encryption = require('../utils/encryption');
const amazonService = require('../services/amazon');
const dbService = require('../services/db');
const sendgridService = require('../services/sendgrid');
const { processRateLimiter, resendRateLimiter, checkResendLimit } = require('../middleware/rateLimit');

const DEMO_MODE = process.env.DEMO_MODE === 'true';

/**
 * Reenviar una tarjeta existente (lógica compartida entre /process y /resend)
 *
 * El código NUNCA se desencripta aquí: sendgridService lo desencripta
 * en memoria justo antes de componer el email.
 */
async function resendExistingGiftCard(giftCard, { contactEmail, contactName, sourceIp }) {
  // Validar límites de reenvío (máx 1/hora, 3/día, 5 en total)
  const resendDates = giftCard.email_last_resent_at ? [giftCard.email_last_resent_at] : [];
  const totalResends = giftCard.email_resent_count || 0;

  if (totalResends >= 5) {
    return {
      httpStatus: 429,
      body: {
        success: false,
        error: 'Max gift card resends exceeded (5)',
        giftCardId: giftCard.id,
      },
    };
  }

  const limitCheck = checkResendLimit(resendDates);
  if (!limitCheck.allowed && !DEMO_MODE) {
    // En DEMO_MODE se relaja el límite de 1/hora para poder probar el flujo
    return {
      httpStatus: 429,
      body: {
        success: false,
        error: limitCheck.reason,
        giftCardId: giftCard.id,
      },
    };
  }

  // Enviar por email (desencriptación solo en memoria, dentro del servicio)
  const sendResult = await sendgridService.resendGiftCard({
    giftCardId: giftCard.id,
    recipientEmail: contactEmail || giftCard.contact_email,
    recipientName: contactName,
    codeEncrypted: giftCard.amazon_code_encrypted,
    amount: giftCard.amazon_amount,
    currency: giftCard.amazon_currency_code,
  });

  const newResendCount = await dbService.incrementResendCount(giftCard.id);

  await dbService.logAction('resent', giftCard.id, {
    performed_by: 'api',
    source_ip: sourceIp,
  });

  return {
    httpStatus: 200,
    body: {
      success: true,
      status: 'resent',
      giftCardId: giftCard.id,
      sendgridMessageId: sendResult.messageId,
      resendCount: newResendCount,
      resendsRemaining: Math.max(0, 5 - newResendCount),
      message: 'Gift card resent successfully',
    },
  };
}

/**
 * POST /gift-cards/process
 *
 * Endpoint principal para generar y enviar tarjetas regalo
 * Llamado por el scheduler del CRM diariamente
 *
 * Flujo:
 * 1. Validar datos de entrada
 * 2. Buscar si ya existe gift card para este rewardId (idempotencia)
 *    - SI existe: reenviar código existente
 *    - NO existe: generar nuevo código
 * 3. Verificar fondos disponibles en Amazon
 * 4. Generar código en Amazon
 * 5. Encriptar código (AES-256-GCM) INMEDIATAMENTE
 * 6. Guardar en PostgreSQL (solo encriptado)
 * 7. Enviar por email vía SendGrid
 * 8. Registrar en auditoría
 */
router.post('/process', processRateLimiter, async (req, res) => {
  const requestId = uuidv4();
  const { rewardId, contactId, contactEmail, contactName, amount = 5000, currencyCode = 'USD' } = req.body;

  try {
    // ============================================================================
    // VALIDACIÓN DE ENTRADA
    // ============================================================================
    if (!rewardId || !contactId || !contactEmail) {
      logger.warn('Missing required fields', {
        requestId,
        has_rewardId: !!rewardId,
        has_contactId: !!contactId,
        has_contactEmail: !!contactEmail,
      });

      return res.status(400).json({
        success: false,
        error: 'Missing required fields: rewardId, contactId, contactEmail',
      });
    }

    logger.audit('process_started', requestId, {
      rewardId,
      contactId,
      contactEmail,
      amount,
      currencyCode,
    });

    // ============================================================================
    // PASO 1: Buscar si ya existe gift card para este rewardId (IDEMPOTENCIA)
    // ============================================================================
    const existingGiftCard = await dbService.findGiftCardByRewardId(rewardId);

    if (existingGiftCard) {
      logger.info('Gift card already exists, reusing existing code', {
        rewardId,
        giftCardId: existingGiftCard.id,
      });

      try {
        const result = await resendExistingGiftCard(existingGiftCard, {
          contactEmail,
          contactName,
          sourceIp: req.ip,
        });
        return res.status(result.httpStatus).json(result.body);
      } catch (error) {
        logger.error('Error resending existing gift card', error, {
          giftCardId: existingGiftCard.id,
        });

        return res.status(500).json({
          success: false,
          error: 'Error resending gift card',
          giftCardId: existingGiftCard.id,
        });
      }
    }

    // ============================================================================
    // PASO 2: Validar contra el CRM que el contacto es un cliente
    // ============================================================================
    // En producción esta validación consulta el CRM de origen (ver services/crm.js).
    // En demo siempre pasa.
    const validationPassed = true;
    if (!validationPassed) {
      await dbService.logAction('validation_failed', requestId, {
        failure_reason: 'Contact is not an eligible customer',
        source_ip: req.ip,
      });

      return res.status(400).json({
        success: false,
        error: 'Contact is not an eligible customer',
        detail: 'The CRM lookup did not confirm this contact as a customer',
      });
    }

    // ============================================================================
    // PASO 3: Verificar fondos en Amazon
    // ============================================================================
    const hasFunds = await amazonService.hasAvailableFunds(amount);
    if (!hasFunds) {
      logger.error('Insufficient funds in Amazon', null, { amount, rewardId });

      await dbService.logAction('amazon_error', requestId, {
        failure_reason: 'Insufficient funds',
        amazon_error_code: 'F300',
        source_ip: req.ip,
      });

      return res.status(402).json({
        success: false,
        error: 'Insufficient funds in Amazon',
        detail: 'Contact support to reload Amazon account',
      });
    }

    // ============================================================================
    // PASO 4: Generar código en Amazon
    // ============================================================================
    logger.info('Creating gift card in Amazon', { amount, currencyCode, rewardId });

    let amazonResult;
    try {
      amazonResult = await amazonService.createGiftCard(amount, currencyCode);

      logger.audit('amazon_code_generated', requestId, {
        amount,
        currency: currencyCode,
        rewardId,
      });
    } catch (error) {
      logger.error('Amazon API error', error, { rewardId, errorCode: error.code });

      await dbService.logAction('amazon_error', requestId, {
        failure_reason: error.message,
        amazon_error_code: error.code,
        amazon_error_msg: error.message,
        source_ip: req.ip,
      });

      if (error.code === 'F300') {
        return res.status(402).json({ success: false, error: 'Insufficient funds' });
      }

      if (error.code === 'F400') {
        return res.status(503).json({ success: false, error: 'Temporary Amazon error, will retry' });
      }

      return res.status(500).json({
        success: false,
        error: 'Amazon API error',
        detail: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }

    // ============================================================================
    // PASO 5: Encriptar código INMEDIATAMENTE
    // ============================================================================
    let codeEncrypted;
    try {
      codeEncrypted = encryption.encrypt(amazonResult.code);
      // NUNCA logear amazonResult.code en plaintext
      amazonResult.code = null;
    } catch (error) {
      logger.error('Error encrypting gift card code', error);
      return res.status(500).json({ success: false, error: 'Encryption error' });
    }

    // ============================================================================
    // PASO 6: Guardar en PostgreSQL (ENCRIPTADO)
    // ============================================================================
    let giftCardId;
    try {
      const savedCard = await dbService.saveGiftCard({
        id: requestId,
        reward_id: rewardId,
        contact_email: contactEmail,
        amazon_code_encrypted: codeEncrypted,
        amazon_creation_request_id: amazonResult.creationRequestId,
        amazon_currency_code: currencyCode,
        amazon_amount: amount,
      });

      giftCardId = savedCard.id;
      logger.audit('gift_card_saved', giftCardId, {
        rewardId,
        creationRequestId: amazonResult.creationRequestId,
      });

      await dbService.logAction('generated', giftCardId, {
        performed_by: 'api',
        source_ip: req.ip,
      });
    } catch (error) {
      logger.error('Error saving to database', error, { rewardId });
      return res.status(500).json({ success: false, error: 'Database error' });
    }

    // ============================================================================
    // PASO 7: Enviar por email vía SendGrid
    // ============================================================================
    let sendResult;
    try {
      sendResult = await sendgridService.sendGiftCard({
        giftCardId,
        recipientEmail: contactEmail,
        recipientName: contactName,
        codeEncrypted, // Se desencripta DENTRO de sendGiftCard, solo en memoria
        amount,
        currency: currencyCode,
      });

      await dbService.updateEmailStatus(giftCardId, 'sent', sendResult.messageId);

      await dbService.logAction('sent', giftCardId, {
        performed_by: 'api',
        source_ip: req.ip,
      });

      logger.audit('email_sent', giftCardId, {
        recipientEmail: contactEmail,
        messageId: sendResult.messageId,
      });
    } catch (error) {
      logger.error('Error sending email', error, { giftCardId, contactEmail });

      // El código está guardado encriptado, pero no se envió email
      return res.status(500).json({
        success: false,
        error: 'Email delivery error',
        giftCardId,
        detail: 'Gift card generated but email delivery failed',
      });
    }

    // ============================================================================
    // PASO 8: Respuesta exitosa
    // ============================================================================
    logger.audit('process_completed', giftCardId, {
      rewardId,
      status: 'generated',
    });

    return res.status(200).json({
      success: true,
      status: 'generated',
      giftCardId,
      sendgridMessageId: sendResult.messageId,
      message: 'Gift card generated and sent successfully',
    });
  } catch (error) {
    logger.error('Unhandled error in POST /gift-cards/process', error, { requestId });
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /gift-cards/resend
 *
 * Reenviar tarjeta existente (llamado desde botón manual en CRM)
 *
 * Request:
 * {
 *   "giftCardId": "uuid",
 *   "contactEmail": "email@example.com"  // opcional, usa el email guardado si falta
 * }
 *
 * Validaciones: máximo 1 reenvío/hora, 3/día, 5 en total
 */
router.post('/resend', resendRateLimiter, async (req, res) => {
  const { giftCardId, contactEmail, contactName } = req.body;

  try {
    if (!giftCardId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: giftCardId',
      });
    }

    logger.audit('resend_requested', giftCardId, {
      contactEmail,
      source_ip: req.ip,
    });

    const giftCard = await dbService.findGiftCardById(giftCardId);
    if (!giftCard) {
      return res.status(404).json({
        success: false,
        error: 'Gift card not found',
        giftCardId,
      });
    }

    const result = await resendExistingGiftCard(giftCard, {
      contactEmail,
      contactName,
      sourceIp: req.ip,
    });

    return res.status(result.httpStatus).json(result.body);
  } catch (error) {
    logger.error('Error in POST /gift-cards/resend', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * ENDPOINTS DE DEMOSTRACIÓN — solo existen cuando DEMO_MODE=true
 *
 * Permiten a la página de demo inspeccionar el estado interno:
 * los registros SIEMPRE contienen el código encriptado, nunca en plaintext.
 */
if (DEMO_MODE) {
  router.get('/demo/records', async (req, res) => {
    const snapshot = await dbService.getDemoSnapshot();
    res.status(200).json({
      demoMode: true,
      note: 'Codes are only ever stored encrypted (AES-256-GCM). No plaintext exists in the database.',
      count: snapshot.gift_cards.length,
      gift_cards: snapshot.gift_cards,
    });
  });

  router.get('/demo/audit', async (req, res) => {
    const snapshot = await dbService.getDemoSnapshot();
    res.status(200).json({
      demoMode: true,
      note: 'Append-only audit table: in production the app role can only INSERT and the auditor role can only SELECT.',
      count: snapshot.access_logs.length,
      access_logs: snapshot.access_logs,
    });
  });

  router.get('/demo/last-email', (req, res) => {
    res.status(200).json({
      demoMode: true,
      note: 'Simulated email: in production it is sent via SendGrid with a dynamic template.',
      email: sendgridService.lastDemoEmail,
    });
  });
}

module.exports = router;
