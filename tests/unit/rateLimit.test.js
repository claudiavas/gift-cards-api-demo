/**
 * Tests para Rate Limiting
 *
 * Verificar:
 * - Límite de 100 requests/hora
 * - Límite específico de reenvíos (1/h, 3/d, 5/total)
 * - Headers informativos
 */

const { checkResendLimit } = require('../../src/middleware/rateLimit');

describe('Rate Limiting', () => {
  describe('checkResendLimit', () => {
    test('debe permitir primer reenvío', () => {
      const result = checkResendLimit([]);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    test('debe bloquear 2do reenvío dentro de 1 hora', () => {
      const now = new Date();
      const oneHourAgo = new Date(now - 30 * 60 * 1000); // 30 minutos atrás

      const result = checkResendLimit([oneHourAgo]);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Only 1 resend per hour allowed');
    });

    test('debe permitir reenvío después de 1 hora', () => {
      const now = new Date();
      const moreThan1HourAgo = new Date(now - 61 * 60 * 1000); // 61 minutos atrás

      const result = checkResendLimit([moreThan1HourAgo]);

      expect(result.allowed).toBe(true);
    });

    test('debe bloquear 4to reenvío en el mismo día', () => {
      const now = new Date();
      const dates = [
        new Date(now - 120 * 60 * 1000), // 2h atrás
        new Date(now - 90 * 60 * 1000),  // 1.5h atrás
        new Date(now - 60 * 60 * 1000),  // 1h atrás
      ];

      const result = checkResendLimit(dates);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Max 3 resends per day reached');
    });

    test('debe bloquear 6to reenvío en total', () => {
      const now = new Date();
      const dates = [
        new Date(now - 5 * 24 * 60 * 60 * 1000), // 5 días atrás
        new Date(now - 4 * 24 * 60 * 60 * 1000),
        new Date(now - 3 * 24 * 60 * 60 * 1000),
        new Date(now - 2 * 24 * 60 * 60 * 1000),
      ];

      const result = checkResendLimit(dates);

      expect(result.allowed).toBe(true); // Aún permitido (4 reenvíos)

      // El 5to reenvío agota el límite total
      dates.push(new Date(now - 12 * 60 * 60 * 1000));
      const resultBlocked = checkResendLimit(dates);

      expect(resultBlocked.allowed).toBe(false);
      expect(resultBlocked.reason).toContain('Max 5 total resends reached');
    });

    test('debe retornar información de límites restantes', () => {
      const now = new Date();
      const dates = [new Date(now - 3 * 24 * 60 * 60 * 1000)]; // 3 días atrás

      const result = checkResendLimit(dates);

      expect(result.limits).toBeDefined();
      expect(result.limits.hour).toBeGreaterThanOrEqual(0);
      expect(result.limits.day).toBeGreaterThanOrEqual(0);
      expect(result.limits.total).toBeGreaterThanOrEqual(0);
    });
  });
});
