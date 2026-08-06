/**
 * DB Service - PostgreSQL como almacén seguro de códigos encriptados
 *
 * Tablas:
 * 1. gift_cards - Códigos encriptados y metadata
 * 2. access_logs - Auditoría append-only de accesos
 *
 * POR QUÉ POSTGRESQL:
 * - La idempotencia la garantiza la BD, no la aplicación: UNIQUE (reward_id)
 *   y UNIQUE (amazon_creation_request_id) hacen imposible generar (y pagar)
 *   dos tarjetas para el mismo reward, incluso con requests concurrentes.
 * - Transacciones ACID: contador de reenvíos + auditoría se actualizan juntos.
 * - Workload OLTP (búsquedas puntuales, pocas filas): milisegundos y barato.
 *
 * SEGURIDAD:
 * - Los códigos se almacenan ENCRIPTADOS SIEMPRE (AES-256-GCM en la app)
 * - access_logs es append-only: en producción el rol de la aplicación solo
 *   tiene INSERT (se revoca UPDATE/DELETE) y el rol auditor solo SELECT
 *
 * Sin DATABASE_URL la instancia usa un almacén en memoria (útil para
 * desarrollo local sin Postgres); con DATABASE_URL persiste de verdad.
 */

const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class DBService {
  constructor() {
    this.demoMode = process.env.DEMO_MODE === 'true';
    this.databaseUrl = process.env.DATABASE_URL || null;

    if (this.databaseUrl) {
      this.pool = new Pool({
        connectionString: this.databaseUrl,
        max: 5,
        // Railway/Heroku externos requieren SSL; la red interna no
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      });
      this.ready = this._initSchema();
      logger.info('DB service initialized (PostgreSQL)');
    } else {
      if (!this.demoMode) {
        throw new Error('DATABASE_URL no está definida. Configurar PostgreSQL o usar DEMO_MODE=true');
      }
      this.memGiftCards = [];
      this.memAccessLogs = [];
      this.ready = Promise.resolve();
      logger.info('DB service initialized (in-memory store, no DATABASE_URL)');
    }
  }

  /**
   * Crear el esquema si no existe
   *
   * Los UNIQUE son la pieza central: la idempotencia no depende de que la
   * aplicación compruebe antes de insertar (eso sería una race condition).
   * @private
   */
  async _initSchema() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gift_cards (
        id UUID PRIMARY KEY,
        reward_id TEXT NOT NULL UNIQUE,
        contact_email TEXT NOT NULL,
        amazon_code_encrypted TEXT NOT NULL,
        amazon_creation_request_id TEXT NOT NULL UNIQUE,
        amazon_currency_code TEXT DEFAULT 'USD',
        amazon_amount INTEGER,
        sendgrid_message_id TEXT,
        email_sent BOOLEAN NOT NULL DEFAULT false,
        email_sent_at TIMESTAMPTZ,
        email_resent_count INTEGER NOT NULL DEFAULT 0,
        email_last_resent_at TIMESTAMPTZ,
        email_status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS access_logs (
        id UUID PRIMARY KEY,
        gift_card_id TEXT,
        action TEXT NOT NULL,
        performed_by TEXT,
        source_ip TEXT,
        failure_reason TEXT,
        amazon_error_code TEXT,
        amazon_error_msg TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // En demo pública, purgar registros antiguos para que la tabla no crezca sin límite
    if (this.demoMode) {
      await this.pool.query(`DELETE FROM gift_cards WHERE created_at < now() - interval '7 days'`);
      await this.pool.query(`DELETE FROM access_logs WHERE created_at < now() - interval '7 days'`);
    }

    logger.info('PostgreSQL schema ready');
  }

  /**
   * Guardar un código encriptado en gift_cards
   *
   * ON CONFLICT (reward_id) DO NOTHING: si dos requests concurrentes llegan
   * con el mismo reward, solo una inserta — la otra recibe el error de
   * duplicado y reutiliza la tarjeta existente.
   *
   * @param {object} giftCard - { id, reward_id, contact_email, amazon_code_encrypted, ... }
   * @returns {Promise<object>} Registro guardado
   */
  async saveGiftCard(giftCard) {
    // IMPORTANTE: El código debe venir YA ENCRIPTADO
    if (!giftCard.amazon_code_encrypted) {
      throw new Error('Code must be encrypted before saving');
    }

    const required = ['reward_id', 'contact_email', 'amazon_code_encrypted', 'amazon_creation_request_id'];
    for (const field of required) {
      if (!giftCard[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    const row = {
      id: giftCard.id || uuidv4(),
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

    if (!this.pool) {
      if (this.memGiftCards.some(c => c.reward_id === row.reward_id)) {
        throw new Error('UNIQUE constraint: gift card already exists for this rewardId');
      }
      this.memGiftCards.push(row);
    } else {
      await this.ready;
      const result = await this.pool.query(
        `INSERT INTO gift_cards
           (id, reward_id, contact_email, amazon_code_encrypted, amazon_creation_request_id,
            amazon_currency_code, amazon_amount, email_status, email_sent, email_resent_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', false, 0)
         ON CONFLICT (reward_id) DO NOTHING
         RETURNING *`,
        [row.id, row.reward_id, row.contact_email, row.amazon_code_encrypted,
         row.amazon_creation_request_id, row.amazon_currency_code, row.amazon_amount]
      );

      if (result.rows.length === 0) {
        // Otra request ganó la carrera: la tarjeta ya existe para este reward
        throw new Error('UNIQUE constraint: gift card already exists for this rewardId');
      }
    }

    logger.audit('gift_card_saved', row.id, {
      reward_id: giftCard.reward_id,
      creationRequestId: giftCard.amazon_creation_request_id,
    });

    return row;
  }

  /**
   * Buscar gift card por rewardId
   * @param {string} rewardId - ID externo de la recompensa (idempotencia)
   * @returns {Promise<object|null>}
   */
  async findGiftCardByRewardId(rewardId) {
    if (!this.pool) {
      return this.memGiftCards.find(c => c.reward_id === rewardId) || null;
    }
    await this.ready;
    const result = await this.pool.query(
      'SELECT * FROM gift_cards WHERE reward_id = $1 LIMIT 1',
      [rewardId]
    );
    return result.rows[0] || null;
  }

  /**
   * Buscar gift card por ID
   * @param {string} giftCardId
   * @returns {Promise<object|null>}
   */
  async findGiftCardById(giftCardId) {
    if (!this.pool) {
      return this.memGiftCards.find(c => c.id === giftCardId) || null;
    }
    await this.ready;
    const result = await this.pool.query(
      'SELECT * FROM gift_cards WHERE id = $1 LIMIT 1',
      [giftCardId]
    );
    return result.rows[0] || null;
  }

  /**
   * Registrar una acción en access_logs (auditoría append-only)
   *
   * @param {string} action - generated, sent, resent, validation_failed, amazon_error
   * @param {string} giftCardId - ID de la tarjeta
   * @param {object} metadata - Información adicional
   */
  async logAction(action, giftCardId, metadata = {}) {
    const row = {
      id: uuidv4(),
      gift_card_id: giftCardId,
      action,
      performed_by: metadata.performed_by || 'system',
      source_ip: metadata.source_ip || null,
      failure_reason: metadata.failure_reason || null,
      amazon_error_code: metadata.amazon_error_code || null,
      amazon_error_msg: metadata.amazon_error_msg || null,
      created_at: new Date().toISOString(),
    };

    try {
      if (!this.pool) {
        this.memAccessLogs.push(row);
      } else {
        await this.ready;
        await this.pool.query(
          `INSERT INTO access_logs
             (id, gift_card_id, action, performed_by, source_ip, failure_reason, amazon_error_code, amazon_error_msg)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [row.id, row.gift_card_id, row.action, row.performed_by, row.source_ip,
           row.failure_reason, row.amazon_error_code, row.amazon_error_msg]
        );
      }

      logger.debug(`Action logged: ${action}`, { giftCardId, ...metadata });
      return row;
    } catch (error) {
      logger.error('Error logging action', error, { action, giftCardId });
      // No fallar la operación si el log falla
      return null;
    }
  }

  /**
   * Actualizar estado del email enviado
   */
  async updateEmailStatus(giftCardId, status, sendgridMessageId = null) {
    if (!this.pool) {
      const card = this.memGiftCards.find(c => c.id === giftCardId);
      if (card) {
        card.email_status = status;
        card.email_sent = true;
        card.email_sent_at = new Date().toISOString();
        if (sendgridMessageId) card.sendgrid_message_id = sendgridMessageId;
      }
      return;
    }
    await this.ready;
    await this.pool.query(
      `UPDATE gift_cards
       SET email_status = $2, email_sent = true, email_sent_at = now(),
           sendgrid_message_id = COALESCE($3, sendgrid_message_id)
       WHERE id = $1`,
      [giftCardId, status, sendgridMessageId]
    );

    logger.audit('email_status_updated', giftCardId, { status, sendgridMessageId });
  }

  /**
   * Incrementar contador de reenvíos de una tarjeta
   * @param {string} giftCardId - ID de la tarjeta
   * @returns {Promise<number>} Nuevo contador
   */
  async incrementResendCount(giftCardId) {
    if (!this.pool) {
      const card = this.memGiftCards.find(c => c.id === giftCardId);
      if (!card) throw new Error('Gift card not found');
      card.email_resent_count = (card.email_resent_count || 0) + 1;
      card.email_last_resent_at = new Date().toISOString();
      card.email_status = 'resent';
      return card.email_resent_count;
    }
    await this.ready;
    const result = await this.pool.query(
      `UPDATE gift_cards
       SET email_resent_count = email_resent_count + 1,
           email_last_resent_at = now(),
           email_status = 'resent'
       WHERE id = $1
       RETURNING email_resent_count`,
      [giftCardId]
    );
    if (result.rows.length === 0) throw new Error('Gift card not found');
    return result.rows[0].email_resent_count;
  }

  /**
   * Solo DEMO_MODE: snapshot del almacén para la página de demostración
   * Los códigos solo existen encriptados — no hay nada en plaintext que exponer
   */
  async getDemoSnapshot() {
    if (!this.demoMode) {
      throw new Error('getDemoSnapshot only available in DEMO_MODE');
    }
    if (!this.pool) {
      return { gift_cards: this.memGiftCards, access_logs: this.memAccessLogs };
    }
    await this.ready;
    const cards = await this.pool.query('SELECT * FROM gift_cards ORDER BY created_at DESC LIMIT 20');
    const logs = await this.pool.query('SELECT * FROM access_logs ORDER BY created_at DESC LIMIT 50');
    return { gift_cards: cards.rows, access_logs: logs.rows };
  }
}

// Exportar instancia singleton
module.exports = new DBService();
