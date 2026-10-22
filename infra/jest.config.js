/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', isolatedModules: false }] },
  // Every test synthesizes with skipBundling=true (see test/support/synth.ts): no Docker, no esbuild.
  testTimeout: 120000,
};
