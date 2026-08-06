/**
 * SendGrid Service - Envío de emails con códigos de tarjetas regalo
 *
 * CRÍTICO:
 * - El código se pasa en plaintext a SendGrid (lo necesita)
 * - SendGrid es un tercero certificado SOC 2
 * - NUNCA guardar el código en plaintext en nuestra BD
 * - El código se desencripta SOLO EN MEMORIA para este servicio
 *
 * Flujo seguro:
 * 1. Obtener código encriptado de la base de datos
 * 2. Desencriptar EN MEMORIA
 * 3. Pasar a SendGrid
 * 4. Limpiar variable de memoria (= null)
 * 5. NO guardar plaintext en logs
 */

const sgMail = require('@sendgrid/mail');
const logger = require('../utils/logger');
const encryption = require('../utils/encryption');

class SendGridService {
  constructor() {
    // DEMO_MODE: el envío se simula, no se llama a SendGrid
    this.demoMode = process.env.DEMO_MODE === 'true';
    this.lastDemoEmail = null;

    if (!this.demoMode) {
      // Validar credenciales
      if (!process.env.SENDGRID_API_KEY) {
        throw new Error('SENDGRID_API_KEY no está definida en .env');
      }

      // Inicializar SendGrid
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    }

    this.fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@acme-example.com';
    this.templateId = process.env.SENDGRID_TEMPLATE_ID;

    logger.info('SendGrid service initialized', {
      fromEmail: this.fromEmail,
      hasTemplateId: !!this.templateId,
    });
  }

  /**
   * Enviar email con código de tarjeta
   *
   * IMPORTANTE: El código solo vive en memoria durante esta función
   *
   * @param {object} options - { giftCardId, recipientEmail, recipientName, codeEncrypted, amount, currency }
   * @returns {Promise<{messageId: string, status: string}>}
   */
  async sendGiftCard(options) {
    const {
      giftCardId,
      recipientEmail,
      recipientName,
      codeEncrypted,
      amount,
      currency = 'USD',
    } = options;

    try {
      // Validaciones
      if (!recipientEmail || !codeEncrypted) {
        throw new Error('Missing required fields: recipientEmail, codeEncrypted');
      }

      // PASO CRÍTICO: Desencriptar código SOLO EN MEMORIA
      let plainCode;
      try {
        plainCode = encryption.decrypt(codeEncrypted);
      } catch (error) {
        logger.error('Failed to decrypt gift card code', error, { giftCardId });
        throw new Error('Could not decrypt gift card code');
      }

      // Preparar email
      const msg = {
        to: recipientEmail,
        from: this.fromEmail,
        // Si hay template ID, usarlo; si no, enviar sin template
        ...(this.templateId && { templateId: this.templateId }),
        // Datos dinámicos para la plantilla
        dynamicTemplateData: {
          recipientName: recipientName || 'Amigo',
          giftCardCode: plainCode, // AQUÍ está el código en plaintext, SOLO para SendGrid
          amount: amount || 50,
          currency: currency,
          // Timestamp para referencia
          sentAt: new Date().toISOString(),
        },
      };

      // Enviar email (o simular en DEMO_MODE)
      let messageId;
      if (this.demoMode) {
        messageId = `demo-${require('uuid').v4()}`;
        // Guardar preview del email para la página de demostración
        this.lastDemoEmail = {
          simulated: true,
          to: recipientEmail,
          from: this.fromEmail,
          subject: `🎁 You've received a ${(amount || 5000) / 100} ${currency} gift card!`,
          body: {
            greeting: `Hi ${recipientName || 'there'},`,
            message: 'You have earned a reward. Here is your Amazon gift card:',
            giftCardCode: plainCode,
            amount: (amount || 5000) / 100,
            currency,
          },
          messageId,
          sentAt: new Date().toISOString(),
        };
      } else {
        const response = await sgMail.send(msg);
        messageId = response[0]?.headers?.['x-message-id'] || null;
      }

      logger.audit('email_sent', giftCardId, {
        recipientEmail,
        messageId,
        amount,
        currency,
      });

      // CRÍTICO: Limpiar el código de memoria
      plainCode = null;

      return {
        messageId,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Error sending email', error, {
        giftCardId,
        recipientEmail,
      });

      // Logging de error sin exponer datos sensibles
      const errorDetails = {
        message: error.message,
        status: error.response?.status,
        errorCode: error.code,
      };

      logger.audit('email_send_failed', giftCardId, errorDetails);

      throw error;
    }
  }

  /**
   * Reenviar email con código existente
   *
   * Similar a sendGiftCard pero para reenvíos
   * Incrementa contador de reenvíos
   *
   * @param {object} options - { giftCardId, recipientEmail, recipientName, codeEncrypted }
   * @returns {Promise<{messageId: string, status: string}>}
   */
  async resendGiftCard(options) {
    const {
      giftCardId,
      recipientEmail,
      recipientName,
      codeEncrypted,
      amount,
      currency,
    } = options;

    try {
      logger.audit('resend_attempted', giftCardId, {
        recipientEmail,
      });

      // Usar la misma lógica de envío
      const result = await this.sendGiftCard({
        giftCardId,
        recipientEmail,
        recipientName,
        codeEncrypted,
        amount,
        currency,
      });

      logger.audit('email_resent', giftCardId, {
        recipientEmail,
        messageId: result.messageId,
      });

      return result;
    } catch (error) {
      logger.error('Error resending email', error, {
        giftCardId,
        recipientEmail,
      });

      throw error;
    }
  }

  /**
   * Obtener actividad del email desde SendGrid
   *
   * SendGrid proporciona auditoría de qué pasó con el email
   * (delivered, opened, clicked, bounced, etc)
   *
   * @param {string} messageId - ID del mensaje en SendGrid
   * @returns {Promise<Array>} Eventos del email
   */
  async getEmailActivity(messageId) {
    try {
      if (!messageId) {
        return [];
      }

      // AQUÍ: Implementar llamada a SendGrid API para obtener actividad
      // GET https://api.sendgrid.com/v3/messages?query=msg_id={messageId}
      // Requiere: SendGrid API key con permisos de lectura

      logger.debug('Getting email activity from SendGrid', { messageId });

      // Por ahora, retornar array vacío (implementar en Semana 3)
      return [];
    } catch (error) {
      logger.warn('Could not fetch email activity', error);
      return [];
    }
  }
}

// Exportar instancia singleton
module.exports = new SendGridService();
