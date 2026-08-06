/**
 * Amazon Incentives API Service
 *
 * Encargado de:
 * - Generar solicitudes firmadas con AWS Signature Version 4
 * - Llamar a Amazon para crear gift cards
 * - Manejar reintentos automáticos para F400 y Throttled
 * - Verificar fondos disponibles
 *
 * SEGURIDAD:
 * - Nunca loguear credenciales AWS
 * - Nunca loguear el código generado
 * - Mantener sincronización NTP para timestamp
 */

const aws4 = require('aws4');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class AmazonService {
  constructor() {
    // DEMO_MODE: sin credenciales reales, los códigos se generan localmente
    this.demoMode = process.env.DEMO_MODE === 'true';

    if (!this.demoMode && (!process.env.AMAZON_PARTNER_ID || !process.env.AMAZON_ACCESS_KEY || !process.env.AMAZON_SECRET_KEY)) {
      throw new Error(
        'Credenciales Amazon incompletas. Verificar: AMAZON_PARTNER_ID, AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY'
      );
    }

    this.partnerId = process.env.AMAZON_PARTNER_ID;
    this.accessKey = process.env.AMAZON_ACCESS_KEY;
    this.secretKey = process.env.AMAZON_SECRET_KEY;
    this.region = process.env.AMAZON_REGION || 'us-east-1';
    this.env = process.env.AMAZON_ENV || 'sandbox';

    // URL base según ambiente
    this.baseUrl = this.env === 'production'
      ? 'https://mws.amazonservices.com/onca'
      : 'https://sandbox.mws.amazonservices.com/onca';

    // Configuración de reintentos
    this.maxRetries = 3;
    this.backoffMs = [100, 200, 400]; // Backoff exponencial
  }

  /**
   * Generar firma AWS Signature Version 4 para una solicitud
   *
   * Este es un paso CRÍTICO:
   * - La firma debe estar dentro de ±15 minutos del servidor Amazon
   * - Por eso es necesario NTP sincronizado
   * - Si falla, Amazon rechaza la solicitud con erro de autenticación
   *
   * @param {object} request - Objeto de solicitud HTTP
   * @returns {object} Request con headers de autenticación
   */
  signRequest(request) {
    try {
      const credentials = {
        accessKeyId: this.accessKey,
        secretAccessKey: this.secretKey,
      };

      // aws4.sign maneja toda la complejidad de AWS Signature V4
      const signed = aws4.sign(request, credentials);

      logger.debug('AWS request signed', {
        method: request.method,
        path: request.path,
        timestamp: request.headers['x-amz-date'],
      });

      return signed;
    } catch (error) {
      logger.error('Error signing AWS request', error);
      throw new Error(`AWS signature failed: ${error.message}`);
    }
  }

  /**
   * Crear gift card en Amazon
   *
   * Proceso:
   * 1. Generar creationRequestId único para idempotencia
   * 2. Construir payload
   * 3. Firmar con AWS Signature V4
   * 4. Llamar a Amazon API con reintentos
   * 5. Extraer código si éxito
   * 6. Manejar errores específicos
   *
   * @param {number} amount - Monto en unidades menores (5000 = $50.00)
   * @param {string} currencyCode - Moneda (USD, EUR, etc)
   * @returns {Promise<{code: string, creationRequestId: string}>}
   */
  async createGiftCard(amount, currencyCode = 'USD') {
    // Validaciones básicas
    if (!amount || amount < 100) {
      throw new Error('Amount debe ser >= 100 (en unidades menores)');
    }

    // Generar ID único para idempotencia (CRÍTICO)
    const creationRequestId = uuidv4();

    logger.info('Creating gift card in Amazon', {
      amount,
      currencyCode,
      creationRequestId,
      environment: this.env,
    });

    // Intentar con reintentos
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const giftCard = await this._callAmazonAPI(amount, currencyCode, creationRequestId);

        logger.audit('generated', creationRequestId, {
          amount,
          currencyCode,
          attempts: attempt + 1,
        });

        return {
          code: giftCard.code,
          creationRequestId,
          amount,
          currencyCode,
        };
      } catch (error) {
        // Solo reintentar en F400 (temporary error)
        if (error.code === 'F400' && attempt < this.maxRetries - 1) {
          const delay = this.backoffMs[attempt];
          logger.warn(`F400 error, retrying in ${delay}ms`, {
            attempt: attempt + 1,
            creationRequestId,
          });

          // Esperar antes de reintentar
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Otros errores: fallar inmediatamente
        throw error;
      }
    }

    throw new Error('Max retries exceeded for Amazon API');
  }

  /**
   * Llamada interna a Amazon API
   * Aquí es donde ocurre la comunicación real con Amazon
   *
   * @private
   */
  async _callAmazonAPI(amount, currencyCode, creationRequestId) {
    try {
      // DEMO_MODE / sandbox: generar código localmente sin llamar a Amazon
      if (this.demoMode || this.env === 'sandbox') {
        const raw = uuidv4().replace(/-/g, '').toUpperCase();
        return {
          code: `DEMO-${raw.substring(0, 4)}-${raw.substring(4, 8)}-${raw.substring(8, 12)}`,
          creationRequestId,
        };
      }

      // Construcción de payload para Amazon Incentives API
      // NOTA: Reemplazar con URL y formato real de Amazon
      const payload = {
        Action: 'CreateGiftCard',
        PartnerId: this.partnerId,
        Amount: amount,
        CurrencyCode: currencyCode,
        CreationRequestId: creationRequestId,
        Version: '2013-04-01',
      };

      const request = {
        host: new URL(this.baseUrl).hostname,
        path: '/onca',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'x-amz-target': 'AmazonGiftCardOperationService.CreateGiftCard',
        },
        body: JSON.stringify(payload),
      };

      // Firmar request
      const signed = this.signRequest(request);

      // Hacer llamada HTTP
      const response = await axios.post(this.baseUrl, signed.body, {
        headers: signed.headers,
        timeout: 10000,
      });

      // Parsear respuesta
      const result = response.data;

      // Validar que tiene el código
      if (!result.gcClaimCode) {
        throw new Error('Amazon response sin gcClaimCode');
      }

      return {
        code: result.gcClaimCode,
        creationRequestId,
      };
    } catch (error) {
      // Extraer código de error de Amazon si existe
      const errorCode = error.response?.data?.errorCode || 'UNKNOWN';
      const errorMessage = error.response?.data?.message || error.message;

      logger.error('Amazon API call failed', error, {
        creationRequestId,
        errorCode,
        errorMessage,
      });

      // Crear error con código específico
      const amazonError = new Error(errorMessage);
      amazonError.code = errorCode;
      amazonError.amazonResponse = error.response?.data;

      throw amazonError;
    }
  }

  /**
   * Verificar fondos disponibles en la cuenta
   *
   * @returns {Promise<{available: number, currency: string}>}
   */
  async getAvailableFunds() {
    try {
      // AQUÍ: Implementar llamada real a GetAvailableFunds
      logger.info('Checking available funds');

      // Mock para desarrollo y demo
      if (this.demoMode || this.env === 'sandbox') {
        return {
          available: 500000, // $5000
          currency: 'USD',
        };
      }

      // En producción: llamar a Amazon GetAvailableFunds API
      // ... implementar aquí ...

      return {
        available: 0,
        currency: 'USD',
      };
    } catch (error) {
      logger.error('Error checking available funds', error);
      throw error;
    }
  }

  /**
   * Validar que hay suficientes fondos
   * @param {number} amount - Monto a verificar
   * @returns {Promise<boolean>}
   */
  async hasAvailableFunds(amount) {
    const funds = await this.getAvailableFunds();
    return funds.available >= amount;
  }
}

// Exportar instancia singleton
module.exports = new AmazonService();
