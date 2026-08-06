/**
 * CRM Service - Integración genérica con el CRM de origen
 *
 * La API no depende de un CRM concreto: cualquier sistema capaz de hacer
 * llamadas HTTP (Zoho, HubSpot, Salesforce, un backoffice propio...) puede
 * disparar recompensas. Este servicio cubre la dirección contraria:
 *
 * - Validar que el contacto es un cliente elegible antes de generar la tarjeta
 * - Obtener los datos de la recompensa (rewardId) desde el CRM
 * - Actualizar el estado de la recompensa tras el envío
 *
 * Configuración por variables de entorno:
 * - CRM_API_URL: URL base de la API del CRM
 * - CRM_AUTH_TOKEN: token de autenticación (OAuth u otro)
 *
 * IMPORTANTE: Las credenciales del CRM NO se loguean
 */

const axios = require('axios');
const logger = require('../utils/logger');

class CRMService {
  constructor() {
    // DEMO_MODE: las validaciones se simulan, no se llama a ningún CRM
    this.demoMode = process.env.DEMO_MODE === 'true';

    if (!this.demoMode && (!process.env.CRM_API_URL || !process.env.CRM_AUTH_TOKEN)) {
      throw new Error('Credenciales CRM incompletas. Verificar: CRM_API_URL, CRM_AUTH_TOKEN');
    }

    this.baseUrl = process.env.CRM_API_URL;
    this.authToken = process.env.CRM_AUTH_TOKEN;

    logger.info('CRM service initialized', {
      baseUrl: this.baseUrl || '(demo)',
      demoMode: this.demoMode,
    });
  }

  /**
   * Cabeceras comunes para llamadas al CRM
   * @private
   */
  _headers() {
    return {
      Authorization: `Bearer ${this.authToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Validar que el contacto es un cliente elegible para la recompensa
   *
   * La regla concreta (qué convierte a un contacto en "cliente") vive en el
   * CRM; esta API solo pregunta y respeta la respuesta.
   *
   * @param {string} contactId - ID del contacto en el CRM
   * @returns {Promise<{eligible: boolean, reason?: string}>}
   */
  async validateCustomer(contactId) {
    if (!contactId) {
      throw new Error('contactId es requerido');
    }

    if (this.demoMode) {
      return { eligible: true };
    }

    try {
      const response = await axios.get(
        `${this.baseUrl}/contacts/${encodeURIComponent(contactId)}`,
        { headers: this._headers(), timeout: 10000 }
      );

      const isCustomer = response.data?.isCustomer === true;
      return {
        eligible: isCustomer,
        reason: isCustomer ? undefined : 'Contact is not a customer in the CRM',
      };
    } catch (error) {
      logger.error('Error validating customer in CRM', error, { contactId });
      throw new Error(`CRM validation failed: ${error.message}`);
    }
  }

  /**
   * Obtener los datos de una recompensa desde el CRM
   *
   * @param {string} rewardId - ID externo de la recompensa
   * @returns {Promise<object>} Datos de la recompensa
   */
  async getReward(rewardId) {
    if (!rewardId) {
      throw new Error('rewardId es requerido');
    }

    if (this.demoMode) {
      return { id: rewardId, contactId: 'contact-demo', status: 'pending' };
    }

    try {
      logger.debug('Fetching reward from CRM', { rewardId });

      const response = await axios.get(
        `${this.baseUrl}/rewards/${encodeURIComponent(rewardId)}`,
        { headers: this._headers(), timeout: 10000 }
      );

      return response.data;
    } catch (error) {
      logger.error('Error getting reward from CRM', error, { rewardId });
      throw error;
    }
  }

  /**
   * Actualizar el estado de la recompensa en el CRM tras el envío
   *
   * El CRM solo recibe metadata (enviada/fecha/estado del email),
   * NUNCA el código de la tarjeta.
   *
   * @param {string} rewardId - ID externo de la recompensa
   * @param {object} updates - Campos a actualizar (ej: { giftCardSent: true })
   */
  async updateReward(rewardId, updates) {
    if (this.demoMode) {
      logger.debug('Reward update simulated (DEMO_MODE)', { rewardId, updates });
      return { id: rewardId, ...updates };
    }

    try {
      logger.debug('Updating reward in CRM', { rewardId, fields: Object.keys(updates) });

      const response = await axios.patch(
        `${this.baseUrl}/rewards/${encodeURIComponent(rewardId)}`,
        updates,
        { headers: this._headers(), timeout: 10000 }
      );

      return response.data;
    } catch (error) {
      logger.error('Error updating reward in CRM', error, { rewardId });
      throw error;
    }
  }
}

// Exportar instancia singleton
module.exports = new CRMService();
