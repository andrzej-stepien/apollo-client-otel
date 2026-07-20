import { beforeEach, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import { from } from "@apollo/client/core";
import type { FetchResult } from "@apollo/client/core";

import {
  ATTR_APOLLO_GRAPHQL_ERROR_COUNT,
  ATTR_APOLLO_HAS_GRAPHQL_ERRORS,
  ATTR_APOLLO_PERSISTED_QUERY,
  ATTR_APOLLO_PERSISTED_QUERY_HASH,
  ATTR_APOLLO_RETRY_COUNT,
  METRIC_OPERATION_DURATION,
  METRIC_OPERATION_ERRORS,
  createOpenTelemetryLink,
} from "../src/index";
import {
  createMetricsHarness,
  createTracingHarness,
  gql,
  networkErrorLink,
  runOperation,
  successLink,
} from "./helpers";

const QUERY = gql`
  query GetEmployees {
    employees {
      id
      name
    }
  }
`;

/** Minimal stand-in for Apollo Client 4's CombinedGraphQLErrors. */
class CombinedGraphQLErrorsStub extends Error {
  readonly errors: readonly { message: string }[];
  constructor(errors: { message: string }[]) {
    super(errors.map((e) => e.message).join("\n"));
    this.name = "CombinedGraphQLErrors";
    this.errors = errors;
  }
}

describe("shouldTrace", () => {
  let harness: ReturnType<typeof createTracingHarness>;
  beforeEach(() => {
    harness = createTracingHarness();
  });

  it("skips the span but forwards the operation when it returns false", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        shouldTrace: () => false,
      }),
      successLink({ data: { employees: [] } }),
    ]);

    const outcome = await runOperation(link, { query: QUERY });

    expect(outcome.results).toHaveLength(1);
    expect(harness.spans()).toHaveLength(0);
  });

  it("traces when it returns true and receives the operation", async () => {
    let seenName: string | undefined;
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        shouldTrace: (operation) => {
          seenName = operation.operationName;
          return true;
        },
      }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, { query: QUERY });

    expect(seenName).toBe("GetEmployees");
    expect(harness.spans()).toHaveLength(1);
  });
});

describe("graphql error count", () => {
  let harness: ReturnType<typeof createTracingHarness>;
  beforeEach(() => {
    harness = createTracingHarness();
  });

  it("records apollo.graphql_error_count when the result carries errors", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({
        data: null,
        errors: [
          { message: "a" },
          { message: "b" },
        ] as FetchResult["errors"],
      }),
    ]);

    await runOperation(link, { query: QUERY });

    const [span] = harness.spans();
    expect(span?.attributes[ATTR_APOLLO_GRAPHQL_ERROR_COUNT]).toBe(2);
    expect(span?.attributes[ATTR_APOLLO_HAS_GRAPHQL_ERRORS]).toBe(true);
  });

  it("omits the count on a clean success", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, { query: QUERY });

    const [span] = harness.spans();
    expect(span?.attributes).not.toHaveProperty(
      ATTR_APOLLO_GRAPHQL_ERROR_COUNT,
    );
  });
});

describe("combined graphql error on the error channel (Apollo Client 4 shape)", () => {
  let harness: ReturnType<typeof createTracingHarness>;
  beforeEach(() => {
    harness = createTracingHarness();
  });

  it("classifies a combined graphql error via duck-typing", async () => {
    const combined = new CombinedGraphQLErrorsStub([
      { message: "boom" },
      { message: "bang" },
    ]);
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      networkErrorLink(combined),
    ]);

    const outcome = await runOperation(link, { query: QUERY });
    expect(outcome.error).toBe(combined);

    const [span] = harness.spans();
    expect(span?.attributes[ATTR_APOLLO_HAS_GRAPHQL_ERRORS]).toBe(true);
    expect(span?.attributes[ATTR_APOLLO_GRAPHQL_ERROR_COUNT]).toBe(2);
    expect(span?.attributes["error.type"]).toBe("CombinedGraphQLErrors");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });
});

describe("persisted queries", () => {
  let harness: ReturnType<typeof createTracingHarness>;
  beforeEach(() => {
    harness = createTracingHarness();
  });

  it("flags an APQ from operation extensions and records the hash", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, {
      query: QUERY,
      extensions: {
        persistedQuery: { version: 1, sha256Hash: "abc123hash" },
      },
    });

    const [span] = harness.spans();
    expect(span?.attributes[ATTR_APOLLO_PERSISTED_QUERY]).toBe(true);
    expect(span?.attributes[ATTR_APOLLO_PERSISTED_QUERY_HASH]).toBe(
      "abc123hash",
    );
  });

  it("also reads a persisted query from context", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, {
      query: QUERY,
      context: { persistedQuery: { sha256Hash: "ctxhash" } },
    });

    const [span] = harness.spans();
    expect(span?.attributes[ATTR_APOLLO_PERSISTED_QUERY]).toBe(true);
    expect(span?.attributes[ATTR_APOLLO_PERSISTED_QUERY_HASH]).toBe("ctxhash");
  });

  it("does not set persisted-query attributes for a normal operation", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, { query: QUERY });

    const [span] = harness.spans();
    expect(span?.attributes).not.toHaveProperty(ATTR_APOLLO_PERSISTED_QUERY);
  });
});

describe("retry count", () => {
  let harness: ReturnType<typeof createTracingHarness>;
  beforeEach(() => {
    harness = createTracingHarness();
  });

  it("records apollo.retry_count from context.retryCount", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, {
      query: QUERY,
      context: { retryCount: 3 },
    });

    const [span] = harness.spans();
    expect(span?.attributes[ATTR_APOLLO_RETRY_COUNT]).toBe(3);
  });

  it("omits the attribute when no retry count is present", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, { query: QUERY });

    const [span] = harness.spans();
    expect(span?.attributes).not.toHaveProperty(ATTR_APOLLO_RETRY_COUNT);
  });
});

describe("metrics", () => {
  let harness: ReturnType<typeof createTracingHarness>;
  let metricsHarness: ReturnType<typeof createMetricsHarness>;
  beforeEach(() => {
    harness = createTracingHarness();
    metricsHarness = createMetricsHarness();
  });

  it("records the duration histogram for a successful operation", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        meter: metricsHarness.meter,
      }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, { query: QUERY });

    const metrics = await metricsHarness.collect();
    const duration = metrics.find(
      (m) => m.descriptor.name === METRIC_OPERATION_DURATION,
    );
    expect(duration).toBeDefined();
    expect(duration?.descriptor.unit).toBe("s");
    const point = duration?.dataPoints[0];
    expect(point?.attributes["graphql.operation.name"]).toBe("GetEmployees");
    expect(point?.attributes["graphql.operation.type"]).toBe("query");

    // No error counter data points for a clean success.
    const errors = metrics.find(
      (m) => m.descriptor.name === METRIC_OPERATION_ERRORS,
    );
    expect(errors?.dataPoints ?? []).toHaveLength(0);
  });

  it("increments the error counter with error.type on a network error", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        meter: metricsHarness.meter,
      }),
      networkErrorLink(new TypeError("Failed to fetch")),
    ]);

    await runOperation(link, { query: QUERY });

    const metrics = await metricsHarness.collect();
    const errors = metrics.find(
      (m) => m.descriptor.name === METRIC_OPERATION_ERRORS,
    );
    const point = errors?.dataPoints[0];
    expect(point?.value).toBe(1);
    expect(point?.attributes["error.type"]).toBe("TypeError");
  });

  it("does not throw when enableMetrics is set without a global provider", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        enableMetrics: true,
      }),
      successLink({ data: { employees: [] } }),
    ]);

    const outcome = await runOperation(link, { query: QUERY });
    expect(outcome.results).toHaveLength(1);
  });
});
