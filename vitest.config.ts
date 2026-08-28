import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup/no-network.ts"],
    testTimeout: 15_000,
    restoreMocks: true,
  },
});
