import { defineConfig } from "vitest/config";

/**
 * Runs the library end-to-end against Apollo Client 4, installed as the npm
 * alias `apollo-client-v4` (`npm:@apollo/client@^4`). Every `@apollo/client`
 * and `@apollo/client/*` specifier - in both `src` and the v4 tests - is
 * rewritten to the aliased v4 package, so the source under test actually runs on
 * Apollo Client 4's `ApolloLink`/`Observable` (rxjs) implementation.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@apollo\/client$/, replacement: "apollo-client-v4" },
      { find: /^@apollo\/client\/(.*)$/, replacement: "apollo-client-v4/$1" },
    ],
  },
  test: {
    environment: "node",
    globals: true,
    include: ["test/v4/**/*.test.ts"],
  },
});
