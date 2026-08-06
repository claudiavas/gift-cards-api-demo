/**
 * Tests para Sanitizer
 *
 * Verificar que:
 * - Se remuevan códigos de tarjetas
 * - Se remuevan claves AWS
 * - Se remuevan tokens de API
 * - Se preserven datos normales
 */

const { sanitize } = require('../../src/middleware/sanitizer');

describe('Sanitizer', () => {
  test('debe remover códigos de tarjeta Amazon', () => {
    const input = 'Código generado: ABCD-EFGH-IJKL-MNOP para usuario';
    const output = sanitize(input);

    expect(output).not.toContain('ABCD-EFGH-IJKL-MNOP');
    expect(output).toContain('[REDACTED_AMAZON_CODE]');
  });

  test('debe remover claves AWS Access Key', () => {
    const input = 'Error con clave AKIA1234567890ABCDEF';
    const output = sanitize(input);

    expect(output).not.toContain('AKIA1234567890ABCDEF');
    expect(output).toContain('[REDACTED_AWS_KEY]');
  });

  test('debe remover claves SendGrid', () => {
    const input = 'API key: SG.abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz';
    const output = sanitize(input);

    expect(output).not.toContain('SG.');
    expect(output).toContain('[REDACTED_SENDGRID_KEY]');
  });

  test('debe preservar datos normales', () => {
    const input = 'Usuario juan@example.com ha completado el curso';
    const output = sanitize(input);

    // Puede o no preservar el email dependiendo de si está configurado
    expect(output).toContain('completado');
  });

  test('debe manejar múltiples códigos', () => {
    const input = 'Códigos: AAAA-BBBB-CCCC-DDDD y EEEE-FFFF-GGGG-HHHH';
    const output = sanitize(input);

    expect(output).not.toContain('AAAA-BBBB-CCCC-DDDD');
    expect(output).not.toContain('EEEE-FFFF-GGGG-HHHH');
    expect((output.match(/REDACTED/g) || []).length).toBe(2);
  });

  test('debe manejar input no-string', () => {
    expect(sanitize(null)).toBe('null');
    expect(sanitize(123)).toBe('123');
    expect(sanitize(undefined)).toBe('undefined');
  });

  test('debe ser idempotente (aplicar dos veces da el mismo resultado)', () => {
    const input = 'Código: ABCD-EFGH-IJKL-MNOP y clave AKIA1234567890ABCDEF';
    const once = sanitize(input);
    const twice = sanitize(once);

    expect(once).toBe(twice);
  });
});
