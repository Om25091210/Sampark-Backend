import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/test/setup.ts'],
    clearMocks: true,
    // Every integration test file shares ONE real Postgres DB (no per-file schema
    // or transaction isolation) -- running files in parallel (Vitest's default)
    // lets one file's count-based assertions (e.g. stats.test.ts's reportingRecency
    // partition check) observe another file's in-flight fixture rows mid-test,
    // failing non-deterministically. Confirmed via a CI run that failed only on
    // that kind of assertion while every file passed cleanly run serially. Serial
    // execution costs CI a slower run (~70s locally for the full suite) in
    // exchange for a deploy gate that means what it says.
    fileParallelism: false,
  },
});
