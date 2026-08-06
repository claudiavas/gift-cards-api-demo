/**
 * Tests para Encryption Service
 *
 * Verificar:
 * - Encriptación y desencriptación
 * - Que el código no queda en plaintext
 * - Validación de clave de encriptación
 */

describe('Encryption Service', () => {
  let encryption;

  beforeEach(() => {
    // Limpiar require cache para cada test
    jest.resetModules();
    // Asegurarse que ENCRYPTION_KEY esté definida
    process.env.ENCRYPTION_KEY = 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE='; // 32 bytes en base64
    encryption = require('../../src/utils/encryption');
  });

  test('debe encriptar un código', () => {
    const plainCode = 'ABCD-EFGH-IJKL-MNOP';
    const encrypted = encryption.encrypt(plainCode);

    // El código encriptado debe ser diferente al original
    expect(encrypted).not.toBe(plainCode);
    // Debe ser base64
    expect(encrypted).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  test('debe desencriptar un código', () => {
    const plainCode = 'ABCD-EFGH-IJKL-MNOP';
    const encrypted = encryption.encrypt(plainCode);
    const decrypted = encryption.decrypt(encrypted);

    expect(decrypted).toBe(plainCode);
  });

  test('debe generar diferentes valores encriptados para el mismo código', () => {
    const plainCode = 'ABCD-EFGH-IJKL-MNOP';
    const encrypted1 = encryption.encrypt(plainCode);
    const encrypted2 = encryption.encrypt(plainCode);

    // Deben ser diferentes (IV aleatorio)
    expect(encrypted1).not.toBe(encrypted2);
    // Pero deben desencriptar al mismo valor
    expect(encryption.decrypt(encrypted1)).toBe(plainCode);
    expect(encryption.decrypt(encrypted2)).toBe(plainCode);
  });

  test('debe fallar con código encriptado inválido', () => {
    const invalidEncrypted = 'invalid-base64!@#$';

    expect(() => {
      encryption.decrypt(invalidEncrypted);
    }).toThrow();
  });

  test('debe fallar si ENCRYPTION_KEY no está definida', () => {
    delete process.env.ENCRYPTION_KEY;
    jest.resetModules();

    expect(() => {
      require('../../src/utils/encryption');
    }).toThrow('ENCRYPTION_KEY no está definida en .env');
  });

  test('canDecrypt debe retornar true para código válido', () => {
    const plainCode = 'ABCD-EFGH-IJKL-MNOP';
    const encrypted = encryption.encrypt(plainCode);

    expect(encryption.canDecrypt(encrypted)).toBe(true);
  });

  test('canDecrypt debe retornar false para código inválido', () => {
    expect(encryption.canDecrypt('invalid-code')).toBe(false);
  });
});
