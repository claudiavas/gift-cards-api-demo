/**
 * Encryption Service - AES-256 para códigos de tarjetas regalo
 *
 * CRÍTICO: Este módulo es la primera línea de defensa contra acceso no autorizado
 * - Encripta códigos Amazon INMEDIATAMENTE al recibirlos
 * - Solo se desencriptan en memoria para enviar por email
 * - NUNCA se guarda el código en plaintext
 */

const crypto = require('crypto');

class EncryptionService {
  constructor() {
    // La clave de encriptación viene de .env
    // Debe ser 32 caracteres (256 bits) en base64
    const keyBase64 = process.env.ENCRYPTION_KEY;

    if (!keyBase64) {
      throw new Error(
        'ENCRYPTION_KEY no está definida en .env. ' +
        'Generar con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
      );
    }

    try {
      this.key = Buffer.from(keyBase64, 'base64');

      // Validar que la clave tenga el tamaño correcto (32 bytes = 256 bits)
      if (this.key.length !== 32) {
        throw new Error(`Encryption key debe tener 32 bytes, pero tiene ${this.key.length}`);
      }
    } catch (error) {
      throw new Error(`Error al cargar ENCRYPTION_KEY: ${error.message}`);
    }

    // Algoritmo AES-256-GCM (más seguro que CBC)
    this.algorithm = 'aes-256-gcm';
  }

  /**
   * Encriptar un código Amazon
   *
   * Proceso:
   * 1. Generar IV (Initialization Vector) aleatorio
   * 2. Crear cipher con AES-256-GCM
   * 3. Encriptar el código
   * 4. Obtener auth tag para integridad
   * 5. Retornar IV + authTag + ciphertext en base64
   *
   * @param {string} plaintext - Código de tarjeta en plaintext (ej: "ABCD-EFGH-IJKL-MNOP")
   * @returns {string} Código encriptado en formato base64
   */
  encrypt(plaintext) {
    try {
      if (!plaintext || typeof plaintext !== 'string') {
        throw new Error('El código debe ser un string no vacío');
      }

      // Generar IV aleatorio (16 bytes)
      const iv = crypto.randomBytes(16);

      // Crear cipher AES-256-GCM
      const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);

      // Encriptar el código
      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Obtener auth tag (necesario para GCM)
      const authTag = cipher.getAuthTag();

      // Combinar IV + authTag + ciphertext en base64
      // Formato: IV (base64) :: authTag (base64) :: ciphertext (base64)
      const combined = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'hex')]);
      const encoded = combined.toString('base64');

      // NUNCA logear el plaintext o ciphertext
      // Solo confirmar que se encriptó
      return encoded;
    } catch (error) {
      throw new Error(`Error encriptando código: ${error.message}`);
    }
  }

  /**
   * Desencriptar un código Amazon
   *
   * Proceso inverso:
   * 1. Decodificar base64
   * 2. Extraer IV (primeros 16 bytes)
   * 3. Extraer authTag (siguientes 16 bytes)
   * 4. Extraer ciphertext (resto)
   * 5. Desencriptar con decipher
   * 6. Verificar authTag para integridad
   * 7. Retornar plaintext
   *
   * @param {string} encoded - Código encriptado en base64
   * @returns {string} Código desencriptado
   *
   * IMPORTANTE: El plaintext solo debe existir en memoria por un momento.
   * Después de usarlo para SendGrid, DEBE ser nullificado:
   * let code = decrypt(encrypted);
   * // usar code...
   * code = null; // limpiar memoria
   */
  decrypt(encoded) {
    try {
      if (!encoded || typeof encoded !== 'string') {
        throw new Error('Código encriptado debe ser un string no vacío');
      }

      // Decodificar base64
      const combined = Buffer.from(encoded, 'base64');

      // Extraer componentes
      const iv = combined.slice(0, 16); // Primeros 16 bytes
      const authTag = combined.slice(16, 32); // Siguientes 16 bytes
      const ciphertext = combined.slice(32); // El resto

      // Crear decipher
      const decipher = crypto.createDecipheriv(this.algorithm, this.key, iv);

      // Verificar integridad con authTag
      decipher.setAuthTag(authTag);

      // Desencriptar
      let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      throw new Error(`Error desencriptando código: ${error.message}`);
    }
  }

  /**
   * Verificar que se puede desencriptar (para testing)
   * @param {string} encoded - Código encriptado
   * @returns {boolean} true si es válido
   */
  canDecrypt(encoded) {
    try {
      this.decrypt(encoded);
      return true;
    } catch {
      return false;
    }
  }
}

// Exportar instancia singleton
module.exports = new EncryptionService();
