/**
 * Zoho CRM Service
 *
 * Responsable de:
 * - Consultar contacts y referidos en Zoho
 * - Validar que contacto ha pagado (invoice matriculado)
 * - Validar que han pasado >20 días desde matrícula
 * - Actualizar campos en módulo Referidos
 *
 * IMPORTANTE: Las credenciales de Zoho NO se loguean
 */

const axios = require('axios');
const logger = require('../utils/logger');

class ZohoCRMService {
  constructor() {
    if (!process.env.ZOHO_API_URL || !process.env.ZOHO_AUTH_TOKEN) {
      throw new Error('Credenciales Zoho incompletas. Verificar: ZOHO_API_URL, ZOHO_AUTH_TOKEN');
    }

    this.baseUrl = process.env.ZOHO_API_URL;
    this.authToken = process.env.ZOHO_AUTH_TOKEN;
    this.orgId = process.env.ZOHO_ORG_ID;

    logger.info('Zoho CRM service initialized', {
      baseUrl: this.baseUrl,
      hasOrgId: !!this.orgId,
    });
  }

  /**
   * Obtener contacto de Zoho
   *
   * @param {string} contactId - ID del contacto en Zoho
   * @returns {Promise<object>} Datos del contacto
   */
  async getContact(contactId) {
    try {
      if (!contactId) {
        throw new Error('contactId es requerido');
      }

      logger.debug('Fetching contact from Zoho', { contactId });

      // AQUÍ: Implementar llamada real a Zoho API
      // GET https://www.zohoapis.com/crm/v3/Contacts/{contactId}

      // Mock para desarrollo
      return {
        id: contactId,
        email: 'cliente@acme-example.com',
        name: 'Alumno Test',
        status: 'active',
      };
    } catch (error) {
      logger.error('Error getting contact from Zoho', error, { contactId });
      throw error;
    }
  }

  /**
   * Validar que contacto tiene invoice matriculado
   *
   * Query: SELECT * FROM Invoices WHERE contact_id={contactId} AND status="matriculado"
   *
   * @param {string} contactId - ID del contacto
   * @returns {Promise<boolean>} true si tiene invoice matriculado
   */
  async hasMatriculatedInvoice(contactId) {
    try {
      logger.debug('Checking if contact has matriculated invoice', { contactId });

      // AQUÍ: Implementar llamada real a Zoho API
      // GET https://www.zohoapis.com/crm/v3/Invoices
      // ?criteria=(contact_id={contactId} AND status:equals:matriculado)

      // Mock para desarrollo
      return true;
    } catch (error) {
      logger.error('Error checking matriculated invoice', error, { contactId });
      throw error;
    }
  }

  /**
   * Validar que invoice es anterior a 20 días
   *
   * Calcula: TODAY() - invoice_date >= 20 días
   *
   * @param {string} contactId - ID del contacto
   * @returns {Promise<boolean>} true si el invoice es de hace >20 días
   */
  async hasMatriculatedInvoiceOlderThan20Days(contactId) {
    try {
      logger.debug('Checking 20+ days requirement', { contactId });

      // AQUÍ: Implementar lógica
      // 1. Obtener invoices del contacto
      // 2. Filtrar por status="matriculado"
      // 3. Obtener la fecha más antigua
      // 4. Verificar: (TODAY() - date) >= 20 días

      // Mock para desarrollo
      return true;
    } catch (error) {
      logger.error('Error checking 20 days requirement', error, { contactId });
      throw error;
    }
  }

  /**
   * Obtener referido de Zoho
   *
   * @param {string} referidoId - ID del referido
   * @returns {Promise<object>} Datos del referido
   */
  async getReferido(referidoId) {
    try {
      if (!referidoId) {
        throw new Error('referidoId es requerido');
      }

      logger.debug('Fetching referido from Zoho', { referidoId });

      // AQUÍ: Implementar llamada real a Zoho API
      // GET https://www.zohoapis.com/crm/v3/Referidos/{referidoId}

      // Mock para desarrollo
      return {
        id: referidoId,
        referrerId: 'contact-123', // El alumno que hizo la referencia
        referredContactId: 'contact-456', // El alumno que fue referido
        status: 'active',
        created_at: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000), // 25 días atrás
      };
    } catch (error) {
      logger.error('Error getting referido from Zoho', error, { referidoId });
      throw error;
    }
  }

  /**
   * Actualizar campos en módulo Referidos después de generar tarjeta
   *
   * @param {string} referidoId - ID del referido
   * @param {object} updates - Campos a actualizar
   */
  async updateReferido(referidoId, updates) {
    try {
      logger.debug('Updating referido in Zoho', {
        referidoId,
        fields: Object.keys(updates),
      });

      // AQUÍ: Implementar llamada real a Zoho API
      // PUT https://www.zohoapis.com/crm/v3/Referidos/{referidoId}
      // Body: updates

      // Mock para desarrollo
      return {
        id: referidoId,
        ...updates,
      };
    } catch (error) {
      logger.error('Error updating referido in Zoho', error, {
        referidoId,
        fields: Object.keys(updates || {}),
      });
      throw error;
    }
  }

  /**
   * Búsqueda genérica en un módulo de Zoho
   * Útil para queries complejas
   *
   * @param {string} module - Nombre del módulo (Contacts, Invoices, Referidos)
   * @param {string} criteria - Criterio de búsqueda
   * @returns {Promise<Array>} Resultados
   */
  async search(module, criteria) {
    try {
      logger.debug('Searching in Zoho module', {
        module,
        criteriaLength: criteria?.length,
      });

      // AQUÍ: Implementar llamada real a Zoho API
      // GET https://www.zohoapis.com/crm/v3/{module}?criteria={criteria}

      // Mock para desarrollo
      return [];
    } catch (error) {
      logger.error('Error searching Zoho', error, { module });
      throw error;
    }
  }
}

// Exportar instancia singleton
module.exports = new ZohoCRMService();
