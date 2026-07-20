import { describe, expectTypeOf, it } from "vitest";
import type {
  OpenTelemetryLinkOptions,
  SubscriptionMode,
  SubscriptionOptions,
} from "../src/index";

/**
 * Type-level tests for the `subscriptions` option. These are validated by
 * `npm run typecheck` (tsc over `test/`); at runtime the `expectTypeOf`
 * assertions are no-ops and the `@ts-expect-error` lines must each mark a real
 * type error or tsc fails.
 */
describe("subscriptions option types", () => {
  it("exposes the documented shapes", () => {
    expectTypeOf<SubscriptionMode>().toEqualTypeOf<
      "first-emission" | "session"
    >();
    expectTypeOf<SubscriptionOptions["mode"]>().toEqualTypeOf<
      SubscriptionMode | undefined
    >();
    expectTypeOf<SubscriptionOptions["maxEvents"]>().toEqualTypeOf<
      number | undefined
    >();

    const full: OpenTelemetryLinkOptions = {
      subscriptions: { mode: "session", maxEvents: 10 },
    };
    const firstEmission: OpenTelemetryLinkOptions = {
      subscriptions: { mode: "first-emission" },
    };
    const empty: OpenTelemetryLinkOptions = { subscriptions: {} };
    void full;
    void firstEmission;
    void empty;
  });

  it("rejects invalid values", () => {
    const badMode: OpenTelemetryLinkOptions = {
      // @ts-expect-error mode must be one of the union members
      subscriptions: { mode: "streaming" },
    };
    const badMaxEvents: OpenTelemetryLinkOptions = {
      // @ts-expect-error maxEvents must be a number
      subscriptions: { maxEvents: "100" },
    };
    void badMode;
    void badMaxEvents;
  });
});
