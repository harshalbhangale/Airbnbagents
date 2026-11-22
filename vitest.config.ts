import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    // The dashboards refresh every couple of seconds, so checks that wait on them need longer than the default second.
    expect: { poll: { timeout: 10_000 } },
  },
});
