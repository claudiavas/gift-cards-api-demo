/**
 * BigQuery Service - Base de datos segura para códigos encriptados
 *
 * Tablas:
 * 1. gift_cards - Almacena códigos encriptados y metadata
 * 2. access_logs - Auditoría inmutable de accesos
 *
 * SEGURIDAD:
 * - Los códigos se almacenan ENCRIPTADOS SIEMPRE
 * - Usar creationRequestId para idempotencia (UNIQUE constraint)
 * - Solo lectura con Cloud IAM - desarrolladores NO tienen acceso directo
 */

const { BigQuery } = require('@google-cloud/bigquery');
const logger = require('../utils/logger');

class BigQueryService {
  constructor() {
    // DEMO_MODE: almacén en memoria en lugar de BigQuery real
    this.demoMode = process.env.DEMO_MODE === 'true';

    if (this.demoMode) {
      this.demoGiftCards = [];
      this.demoAccessLogs = [];
      logger.info('BigQuery service initialized (DEMO_MODE: in-memory store)');
      return;
    }

    // Validar credenciales
    if (!process.env.GOOGLE_PROJECT_ID || !process.env.GOOGLE_DATASET_ID) {
      throw new Error(
        'Credenciales Google Cloud incompletas. ' +
        'Verificar: GOOGLE_PROJECT_ID, GOOGLE_DATASET_ID'
      );
    }

    try {
      // Inicializar cliente BigQuery
      // En producción, usar GOOGLE_CREDENTIALS_PATH o Application Default Credentials
      this.bigquery = new BigQuery({
        projectId: process.env.GOOGLE_PROJECT_ID,
        // Si GOOGLE_CREDENTIALS_PATH está definido, usarlo
        // keyFilename: process.env.GOOGLE_CREDENTIALS_PATH,
      });

      this.dataset = this.bigquery.dataset(process.env.GOOGLE_DATASET_ID);
      this.giftCardsTable = this.dataset.table('gift_cards');
      this.accessLogsTable = this.dataset.table('access_logs');

      logger.info('BigQuery service initialized', {
        projectId: process.env.GOOGLE_PROJECT_ID,
        dataset: process.env.GOOGLE_DATASET_ID,
      });
    } catch (error) {
      logger.error('Failed to initialize BigQuery', error);
      throw new Error(`BigQuery initialization failed: ${error.message}`);
    }
  }

  /**
   * Crear las tablas si no existen
   *
   * CRÍTICO: Ejecutar una sola vez durante setup
   * Las tablas deben tener constraints UNIQUE para evitar duplicados
   */
  async createTables() {
    try {
      logger.info('Creating BigQuery tables');

      // Tabla: gift_cards
      const giftCardsSchema = [
        { name: 'id', type: 'STRING', mode: 'REQUIRED', description: 'UUID único' },
        { name: 'reward_id', type: 'STRING', mode: 'REQUIRED', description: 'ID externo de la recompensa en el CRM de origen (ÚNICO)' },
        { name: 'contact_email', type: 'STRING', mode: 'REQUIRED', description: 'Email del destinatario (inmutable)' },
        { name: 'amazon_code_encrypted', type: 'STRING', mode: 'REQUIRED', description: 'Código AES-256 encriptado en base64' },
        { name: 'amazon_creation_request_id', type: 'STRING', mode: 'REQUIRED', description: 'UUID para idempotencia (ÚNICO)' },
        { name: 'amazon_currency_code', type: 'STRING', description: 'USD, EUR, JPY, etc' },
        { name: 'amazon_amount', type: 'INTEGER', description: 'Monto en unidades menores' },
        { name: 'amazon_redeemed_at', type: 'TIMESTAMP', description: 'Cuándo se usó (manual desde Dashboard)' },
        { name: 'sendgrid_message_id', type: 'STRING', description: 'ID del email en SendGrid' },
        { name: 'email_sent', type: 'BOOLEAN', mode: 'REQUIRED', defaultValue: 'false' },
        { name: 'email_sent_at', type: 'TIMESTAMP' },
        { name: 'email_resent_count', type: 'INTEGER', defaultValue: '0', description: 'Cuántos reenvíos (máx 5 total)' },
        { name: 'email_last_resent_at', type: 'TIMESTAMP' },
        { name: 'email_status', type: 'STRING', description: 'sent, resent, bounced, opened, etc' },
        { name: 'bounce_reason_es', type: 'STRING', description: 'Motivo de rechazo en español' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED', defaultValue: 'CURRENT_TIMESTAMP()' },
        { name: 'updated_at', type: 'TIMESTAMP', defaultValue: 'CURRENT_TIMESTAMP()' },
      ];

      // Tabla: access_logs
      const accessLogsSchema = [
        { name: 'id', type: 'STRING', mode: 'REQUIRED', description: 'UUID único' },
        { name: 'gift_card_id', type: 'STRING', description: 'Referencia a gift_cards.id' },
        { name: 'action', type: 'STRING', mode: 'REQUIRED', description: 'generated, sent, resent, validation_failed, amazon_error' },
        { name: 'performed_by', type: 'STRING', description: 'scheduler, agent@acme-example.com, system' },
        { name: 'source_ip', type: 'STRING', description: 'IP desde donde se hizo la acción' },
        { name: 'failure_reason', type: 'STRING', description: 'Motivo del fallo si aplica' },
        { name: 'amazon_error_code', type: 'STRING', description: 'F100, F200, F300, F400, F500' },
        { name: 'amazon_error_msg', type: 'STRING', description: 'Mensaje de error de Amazon' },
        { name: 'created_at', type: 'TIMESTAMP', mode: 'REQUIRED', defaultValue: 'CURRENT_TIMESTAMP()' },
      ];

      // Crear tablas
      await this._createTable('gift_cards', giftCardsSchema);
      await this._createTable('access_logs', accessLogsSchema);

      logger.info('BigQuery tables created successfully');
    } catch (error) {
      logger.error('Error creating BigQuery tables', error);
      throw error;
    }
  }

  /**
   * Crear tabla si no existe
   * @private
   */
  async _createTable(tableName, schema) {
    try {
      const table = this.dataset.table(tableName);
      const exists = await table.exists();

      if (exists[0]) {
        logger.debug(`Table ${tableName} already exists`);
        return;
      }

      await this.dataset.createTable(tableName, { schema });
      logger.info(`Created table: ${tableName}`);
    } catch (error) {
      logger.error(`Error creating table ${tableName}`, error);
      throw error;
    }
  }

  /**
   * Guardar un código encriptado en gift_cards
   *
   * @param {object} giftCard - { id, rewardId, contactEmail, codeEncrypted, creationRequestId, ... }
   * @returns {Promise<object>} Registro guardado
   */
  async saveGiftCard(giftCard) {
    try {
      // IMPORTANTE: El código debe venir YA ENCRIPTADO
      if (!giftCard.amazon_code_encrypted) {
        throw new Error('Code must be encrypted before saving');
      }

      // Validación de campos requeridos
      const required = ['reward_id', 'contact_email', 'amazon_code_encrypted', 'amazon_creation_request_id'];
      for (const field of required) {
        if (!giftCard[field]) {
          throw new Error(`Missing required field: ${field}`);
        }
      }

      const row = {
        id: giftCard.id || require('uuid').v4(),
        reward_id: giftCard.reward_id,
        contact_email: giftCard.contact_email,
        amazon_code_encrypted: giftCard.amazon_code_encrypted, // ENCRIPTADO
        amazon_creation_request_id: giftCard.amazon_creation_request_id,
        amazon_currency_code: giftCard.amazon_currency_code || 'USD',
        amazon_amount: giftCard.amazon_amount,
        email_status: 'pending',
        email_sent: false,
        email_resent_count: 0,
        created_at: new Date().toISOString(),
      };

      if (this.demoMode) {
        if (this.demoGiftCards.some(c => c.reward_id === row.reward_id)) {
          throw new Error('UNIQUE constraint: gift card already exists for this rewardId');
        }
        this.demoGiftCards.push(row);
      } else {
        await this.giftCardsTable.insert(row);
      }

      logger.audit('gift_card_saved', row.id, {
        reward_id: giftCard.reward_id,
        creationRequestId: giftCard.amazon_creation_request_id,
      });

      return row;
    } catch (error) {
      logger.error('Error saving gift card', error, {
        rewardId: giftCard?.reward_id,
      });

      // Si es error de UNIQUE constraint, el registro ya existe
      if (error.message?.includes('UNIQUE')) {
        throw new Error('Gift card already exists for this rewardId');
      }

      throw error;
    }
  }

  /**
   * Buscar gift card por rewardId
   * @param {string} rewardId - ID externo de la recompensa (idempotencia)
   * @returns {Promise<object|null>}
   */
  async findGiftCardByRewardId(rewardId) {
    try {
      if (this.demoMode) {
        return this.demoGiftCards.find(c => c.reward_id === rewardId) || null;
      }

      const query = `
        SELECT * FROM \`${process.env.GOOGLE_PROJECT_ID}.${process.env.GOOGLE_DATASET_ID}.gift_cards\`
        WHERE reward_id = @rewardId
        LIMIT 1
      `;

      const options = {
        query,
        params: { rewardId },
      };

      const [rows] = await this.bigquery.query(options);

      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      logger.error('Error finding gift card', error);
      throw error;
    }
  }

  /**
   * Registrar una acción en access_logs (auditoría)
   *
   * @param {string} action - generated, sent, resent, validation_failed, amazon_error
   * @param {string} giftCardId - ID de la tarjeta
   * @param {object} metadata - Información adicional
   */
  async logAction(action, giftCardId, metadata = {}) {
    try {
      const row = {
        id: require('uuid').v4(),
        gift_card_id: giftCardId,
        action,
        performed_by: metadata.performed_by || 'system',
        source_ip: metadata.source_ip || null,
        failure_reason: metadata.failure_reason || null,
        amazon_error_code: metadata.amazon_error_code || null,
        amazon_error_msg: metadata.amazon_error_msg || null,
        created_at: new Date().toISOString(),
      };

      if (this.demoMode) {
        this.demoAccessLogs.push(row);
      } else {
        await this.accessLogsTable.insert(row);
      }

      logger.debug(`Action logged: ${action}`, {
        giftCardId,
        ...metadata,
      });

      return row;
    } catch (error) {
      logger.error('Error logging action', error, {
        action,
        giftCardId,
      });
      // No fallar la operación si el log falla
      return null;
    }
  }

  /**
   * Actualizar estado del email enviado
   */
  async updateEmailStatus(giftCardId, status, sendgridMessageId = null) {
    try {
      if (this.demoMode) {
        const card = this.demoGiftCards.find(c => c.id === giftCardId);
        if (card) {
          card.email_status = status;
          card.email_sent = true;
          card.email_sent_at = new Date().toISOString();
          if (sendgridMessageId) card.sendgrid_message_id = sendgridMessageId;
        }
        return;
      }

      const query = `
        UPDATE \`${process.env.GOOGLE_PROJECT_ID}.${process.env.GOOGLE_DATASET_ID}.gift_cards\`
        SET email_status = @status,
            email_sent = true,
            email_sent_at = CURRENT_TIMESTAMP(),
            sendgrid_message_id = COALESCE(@sendgridMessageId, sendgrid_message_id)
        WHERE id = @giftCardId
      `;

      const options = {
        query,
        params: {
          giftCardId,
          status,
          sendgridMessageId,
        },
      };

      await this.bigquery.query(options);

      logger.audit('email_status_updated', giftCardId, {
        status,
        sendgridMessageId,
      });
    } catch (error) {
      logger.error('Error updating email status', error);
      throw error;
    }
  }

  /**
   * Incrementar contador de reenvíos de una tarjeta
   * @param {string} giftCardId - ID de la tarjeta
   * @returns {Promise<number>} Nuevo contador
   */
  async incrementResendCount(giftCardId) {
    if (this.demoMode) {
      const card = this.demoGiftCards.find(c => c.id === giftCardId);
      if (!card) throw new Error('Gift card not found');
      card.email_resent_count = (card.email_resent_count || 0) + 1;
      card.email_last_resent_at = new Date().toISOString();
      card.email_status = 'resent';
      return card.email_resent_count;
    }

    const query = `
      UPDATE \`${process.env.GOOGLE_PROJECT_ID}.${process.env.GOOGLE_DATASET_ID}.gift_cards\`
      SET email_resent_count = COALESCE(email_resent_count, 0) + 1,
          email_last_resent_at = CURRENT_TIMESTAMP(),
          email_status = 'resent'
      WHERE id = @giftCardId
    `;
    await this.bigquery.query({ query, params: { giftCardId } });
    const [rows] = await this.bigquery.query({
      query: `SELECT email_resent_count FROM \`${process.env.GOOGLE_PROJECT_ID}.${process.env.GOOGLE_DATASET_ID}.gift_cards\` WHERE id = @giftCardId`,
      params: { giftCardId },
    });
    return rows[0]?.email_resent_count || 0;
  }

  /**
   * Buscar gift card por ID
   * @param {string} giftCardId
   * @returns {Promise<object|null>}
   */
  async findGiftCardById(giftCardId) {
    if (this.demoMode) {
      return this.demoGiftCards.find(c => c.id === giftCardId) || null;
    }

    const [rows] = await this.bigquery.query({
      query: `SELECT * FROM \`${process.env.GOOGLE_PROJECT_ID}.${process.env.GOOGLE_DATASET_ID}.gift_cards\` WHERE id = @giftCardId LIMIT 1`,
      params: { giftCardId },
    });
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Solo DEMO_MODE: snapshot del almacén para la página de demostración
   * Los códigos solo existen encriptados — no hay nada en plaintext que exponer
   */
  getDemoSnapshot() {
    if (!this.demoMode) {
      throw new Error('getDemoSnapshot only available in DEMO_MODE');
    }
    return {
      gift_cards: this.demoGiftCards,
      access_logs: this.demoAccessLogs,
    };
  }
}

// Exportar instancia singleton
module.exports = new BigQueryService();
