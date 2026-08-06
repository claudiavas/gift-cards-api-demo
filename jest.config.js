/**
 * Jest Configuration para Gift Cards API
 *
 * Uso:
 * - npm test (todos los tests)
 * - npm run test:watch (en modo watch)
 * - npm run test:coverage (con cobertura)
 */

module.exports = {
  // Ambiente de test
  testEnvironment: 'node',

  // Rutas de tests
  testMatch: [
    '**/tests/**/*.test.js',
    '**/__tests__/**/*.js',
  ],

  // Cobertura
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!src/index.js', // Punto de entrada
  ],

  // Umbrales mínimos de cobertura
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },

  // Setup
  setupFilesAfterEnv: [
    // '<rootDir>/tests/setup.js'  // Si hay setup compartido
  ],

  // Timeout
  testTimeout: 10000,

  // Verbosidad
  verbose: true,

  // No limpiar mocks entre tests
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
};
