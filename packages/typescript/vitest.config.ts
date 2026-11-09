import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["test/*.test.ts"] } },
      // Hits prod, read-only and without a key: npm run test:live
      { test: { name: "live", include: ["test/live/*.test.ts"], testTimeout: 30_000 } },
    ],
  },
});
