import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Apollo Client 4 tests live under test/v4 and run via vitest.v4.config.ts
    // (they need the v4 alias); keep the default suite to the top-level dir.
    include: ["test/*.test.ts"],
  },
});
