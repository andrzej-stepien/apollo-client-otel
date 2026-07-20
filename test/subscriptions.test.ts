import { beforeEach, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { execute, from } from "@apollo/client/core";

import {
  ATTR_APOLLO_CANCELED,
  ATTR_APOLLO_SUBSCRIPTION_ERROR_MESSAGE_COUNT,
  ATTR_APOLLO_SUBSCRIPTION_EVENTS_TRUNCATED,
  ATTR_APOLLO_SUBSCRIPTION_MESSAGE_COUNT,
  SUBSCRIPTION_MESSAGE_EVENT,
  createOpenTelemetryLink,
} from "../src/index";
import {
  createTracingHarness,
  gql,
  openStreamLink,
  runOperation,
  streamingErrorLink,
  streamingLink,
  successLink,
} from "./helpers";

const SUBSCRIPTION = gql`
  subscription OnTick {
    tick
  }
`;

const QUERY = gql`
  query GetEmployees {
    employees {
      id
      name
    }
  }
`;

const ticks = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ data: { tick: i + 1 } }));

/** Counts span events named `apollo.subscription.message`. */
function messageEvents(span: { events: readonly { name: string }[] }): number {
  return span.events.filter((e) => e.name === SUBSCRIPTION_MESSAGE_EVENT).length;
}

describe("subscriptions: session mode", () => {
  let harness: ReturnType<typeof createTracingHarness>;
  beforeEach(() => {
    harness = createTracingHarness();
  });

  it("keeps one span open and adds a payload-free event per emission (complete -> OK)", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        subscriptions: { mode: "session" },
      }),
      streamingLink(ticks(3)),
    ]);

    const outcome = await runOperation(link, { query: SUBSCRIPTION });
    expect(outcome.results).toHaveLength(3);

    const spans = harness.spans();
    expect(spans).toHaveLength(1);
    const [span] = spans;
    expect(span?.name).toBe("subscription OnTick");
    expect(span?.attributes["graphql.operation.type"]).toBe("subscription");
    expect(messageEvents(span!)).toBe(3);
    expect(span?.attributes[ATTR_APOLLO_SUBSCRIPTION_MESSAGE_COUNT]).toBe(3);
    // No truncation with the default maxEvents.
    expect(span?.attributes).not.toHaveProperty(
      ATTR_APOLLO_SUBSCRIPTION_EVENTS_TRUNCATED,
    );
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("never records message payloads in the span events", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        subscriptions: { mode: "session" },
      }),
      streamingLink([{ data: { tick: 42, secret: "sensitive" } }]),
    ]);

    await runOperation(link, { query: SUBSCRIPTION });

    const [span] = harness.spans();
    const events = span?.events ?? [];
    expect(events).toHaveLength(1);
    // The event carries no attributes at all - no payload leaks.
    expect(events[0]?.name).toBe(SUBSCRIPTION_MESSAGE_EVENT);
    expect(events[0]?.attributes ?? {}).toEqual({});
  });

  it("truncates events past maxEvents but keeps counting (events_truncated)", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        subscriptions: { mode: "session", maxEvents: 2 },
      }),
      streamingLink(ticks(5)),
    ]);

    const outcome = await runOperation(link, { query: SUBSCRIPTION });
    // All emissions are still forwarded to the consumer.
    expect(outcome.results).toHaveLength(5);

    const [span] = harness.spans();
    // Only maxEvents span events, but the full count is recorded.
    expect(messageEvents(span!)).toBe(2);
    expect(span?.attributes[ATTR_APOLLO_SUBSCRIPTION_MESSAGE_COUNT]).toBe(5);
    expect(span?.attributes[ATTR_APOLLO_SUBSCRIPTION_EVENTS_TRUNCATED]).toBe(
      true,
    );
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("counts messages carrying GraphQL errors without changing span status", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        subscriptions: { mode: "session" },
        // Even with the gate on, per-message errors must not flip the status -
        // the gate applies to terminal errors only.
        graphQLErrorsAsSpanError: true,
      }),
      streamingLink([
        { data: { tick: 1 } },
        { data: null, errors: [{ message: "boom" }] as never },
        { data: { tick: 3 } },
      ]),
    ]);

    const outcome = await runOperation(link, { query: SUBSCRIPTION });
    expect(outcome.results).toHaveLength(3);

    const [span] = harness.spans();
    expect(span?.attributes[ATTR_APOLLO_SUBSCRIPTION_MESSAGE_COUNT]).toBe(3);
    expect(
      span?.attributes[ATTR_APOLLO_SUBSCRIPTION_ERROR_MESSAGE_COUNT],
    ).toBe(1);
    expect(span?.status.code).toBe(SpanStatusCode.OK);
    expect(span?.attributes["error.type"]).toBeUndefined();
  });

  it("omits error_message_count when no message carried errors", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        subscriptions: { mode: "session" },
      }),
      streamingLink(ticks(2)),
    ]);

    await runOperation(link, { query: SUBSCRIPTION });

    const [span] = harness.spans();
    expect(span?.attributes).not.toHaveProperty(
      ATTR_APOLLO_SUBSCRIPTION_ERROR_MESSAGE_COUNT,
    );
  });

  it("ends the span as ERROR when the subscription errors, keeping the count", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        subscriptions: { mode: "session" },
      }),
      streamingErrorLink(ticks(2), new TypeError("socket closed")),
    ]);

    const outcome = await runOperation(link, { query: SUBSCRIPTION });
    expect(outcome.error).toBeInstanceOf(TypeError);

    const [span] = harness.spans();
    expect(messageEvents(span!)).toBe(2);
    expect(span?.attributes[ATTR_APOLLO_SUBSCRIPTION_MESSAGE_COUNT]).toBe(2);
    expect(span?.attributes["error.type"]).toBe("TypeError");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("on unsubscribe marks apollo.canceled + OK and records the count", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        subscriptions: { mode: "session" },
      }),
      openStreamLink(ticks(2)),
    ]);

    const seen: unknown[] = [];
    const subscription = execute(link, { query: SUBSCRIPTION }).subscribe({
      next: (result) => seen.push(result),
      error: () => {},
      complete: () => {},
    });

    // Flush the queue so both emissions are delivered (the composed link chain
    // delivers them asynchronously); the stream then stays open.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toHaveLength(2);
    expect(harness.spans()).toHaveLength(0);

    subscription.unsubscribe();

    const [span] = harness.spans();
    expect(span).toBeDefined();
    expect(span?.attributes[ATTR_APOLLO_CANCELED]).toBe(true);
    expect(span?.attributes[ATTR_APOLLO_SUBSCRIPTION_MESSAGE_COUNT]).toBe(2);
    expect(messageEvents(span!)).toBe(2);
    // A canceled session ends cleanly, not as an error.
    expect(span?.status.code).toBe(SpanStatusCode.OK);
    expect(span?.attributes["error.type"]).toBeUndefined();
  });

  it("leaves queries untouched in session mode (first-emission behaviour)", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        subscriptions: { mode: "session" },
      }),
      streamingLink([
        { data: { a: 1 } },
        { data: { a: 2 } },
      ]),
    ]);

    const outcome = await runOperation(link, { query: QUERY });
    expect(outcome.results).toHaveLength(2);

    const [span] = harness.spans();
    // A query is never treated as a session: no subscription attributes/events,
    // and the span ends at the first emission exactly as before.
    expect(span?.attributes["graphql.operation.type"]).toBe("query");
    expect(messageEvents(span!)).toBe(0);
    expect(span?.attributes).not.toHaveProperty(
      ATTR_APOLLO_SUBSCRIPTION_MESSAGE_COUNT,
    );
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });
});

describe("subscriptions: default (first-emission) mode is unchanged", () => {
  let harness: ReturnType<typeof createTracingHarness>;
  beforeEach(() => {
    harness = createTracingHarness();
  });

  it("ends a subscription span at the first emission with no session attributes", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      streamingLink(ticks(3)),
    ]);

    const outcome = await runOperation(link, { query: SUBSCRIPTION });
    expect(outcome.results).toHaveLength(3);

    const [span] = harness.spans();
    expect(span?.name).toBe("subscription OnTick");
    expect(messageEvents(span!)).toBe(0);
    expect(span?.attributes).not.toHaveProperty(
      ATTR_APOLLO_SUBSCRIPTION_MESSAGE_COUNT,
    );
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("describeOperation detects graphql.operation.type = subscription", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { tick: 1 } }),
    ]);

    await runOperation(link, { query: SUBSCRIPTION });

    const [span] = harness.spans();
    expect(span?.attributes["graphql.operation.type"]).toBe("subscription");
  });
});
