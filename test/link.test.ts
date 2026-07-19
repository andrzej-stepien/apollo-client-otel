import { beforeEach, describe, expect, it } from "vitest";
import { SpanStatusCode, propagation } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  ApolloLink,
  Observable,
  execute,
  from,
} from "@apollo/client/core";
import type { FetchResult } from "@apollo/client/core";

import { createOpenTelemetryLink } from "../src/index";
import {
  createTracingHarness,
  gql,
  networkErrorLink,
  neverEmitsLink,
  runOperation,
  streamingLink,
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

const MUTATION = gql`
  mutation CreateEmployee {
    createEmployee {
      id
    }
  }
`;

const ANONYMOUS_QUERY = gql`
  {
    employees {
      id
    }
  }
`;

const QUERY_WITH_VARIABLE = gql`
  query GetEmployee($id: ID!) {
    employee(id: $id) {
      name
    }
  }
`;

const QUERY_WITH_INLINE_LITERAL = gql`
  query FindByEmail {
    employee(email: "secret@example.com", limit: 5) {
      name
    }
  }
`;

const INTROSPECTION = gql`
  query IntrospectionQuery {
    __schema {
      queryType {
        name
      }
    }
  }
`;

describe("createOpenTelemetryLink", () => {
  let harness: ReturnType<typeof createTracingHarness>;

  beforeEach(() => {
    harness = createTracingHarness();
  });

  it("names a query span using semantic conventions", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, { query: QUERY });

    const [span] = harness.spans();
    expect(span?.name).toBe("query GetEmployees");
    expect(span?.attributes["graphql.operation.name"]).toBe("GetEmployees");
    expect(span?.attributes["graphql.operation.type"]).toBe("query");
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("names a mutation span using semantic conventions", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { createEmployee: { id: "1" } } }),
    ]);

    await runOperation(link, { query: MUTATION });

    const [span] = harness.spans();
    expect(span?.name).toBe("mutation CreateEmployee");
    expect(span?.attributes["graphql.operation.type"]).toBe("mutation");
  });

  it("handles anonymous operations", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, { query: ANONYMOUS_QUERY });

    const [span] = harness.spans();
    expect(span?.name).toBe("query anonymous");
    expect(span?.attributes["graphql.operation.name"]).toBe("anonymous");
  });

  it("supports a custom spanNameFormatter", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        spanNameFormatter: ({ operationType, operationName }) =>
          `graphql.${operationType}.${operationName}`,
      }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, { query: QUERY });

    const [span] = harness.spans();
    expect(span?.name).toBe("graphql.query.GetEmployees");
  });

  it("records server.address from the operation context uri", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, {
      query: QUERY,
      context: { uri: "https://api.example.com:4000/graphql" },
    });

    const [span] = harness.spans();
    expect(span?.attributes["server.address"]).toBe("api.example.com");
    expect(span?.attributes["server.port"]).toBe(4000);
  });

  it("marks span as ERROR and records the exception on a network error", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      networkErrorLink(new TypeError("Failed to fetch")),
    ]);

    const outcome = await runOperation(link, { query: QUERY });
    expect(outcome.error).toBeInstanceOf(TypeError);

    const [span] = harness.spans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("TypeError");
    expect(span?.attributes["apollo.has_graphql_errors"]).toBe(false);
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("flags GraphQL errors and marks the span ERROR by default", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({
        data: null,
        errors: [{ message: "Field failed" }] as FetchResult["errors"],
      }),
    ]);

    await runOperation(link, { query: QUERY });

    const [span] = harness.spans();
    expect(span?.attributes["apollo.has_graphql_errors"]).toBe(true);
    expect(span?.attributes["error.type"]).toBe("graphql_error");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("keeps span OK for GraphQL errors when graphQLErrorsAsSpanError=false", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        graphQLErrorsAsSpanError: false,
      }),
      successLink({
        data: null,
        errors: [{ message: "Field failed" }] as FetchResult["errors"],
      }),
    ]);

    await runOperation(link, { query: QUERY });

    const [span] = harness.spans();
    expect(span?.attributes["apollo.has_graphql_errors"]).toBe(true);
    expect(span?.attributes["error.type"]).toBeUndefined();
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("skips introspection operations by default", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { __schema: {} } }),
    ]);

    await runOperation(link, { query: INTROSPECTION });

    expect(harness.spans()).toHaveLength(0);
  });

  it("traces introspection when skipIntrospection=false", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        skipIntrospection: false,
      }),
      successLink({ data: { __schema: {} } }),
    ]);

    await runOperation(link, { query: INTROSPECTION });

    expect(harness.spans()).toHaveLength(1);
  });

  it("never records variables in span attributes", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        includeDocument: true,
      }),
      successLink({ data: { employee: { name: "x" } } }),
    ]);

    await runOperation(link, {
      query: QUERY_WITH_VARIABLE,
      variables: { id: "super-secret-id" },
    });

    const [span] = harness.spans();
    const serialized = JSON.stringify(span?.attributes);
    expect(serialized).not.toContain("super-secret-id");
    expect(span?.attributes).not.toHaveProperty("graphql.variables");
    expect(serialized).not.toContain("variables");
  });

  it("omits graphql.document unless includeDocument is enabled", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      successLink({ data: { employees: [] } }),
    ]);

    await runOperation(link, { query: QUERY });

    const [span] = harness.spans();
    expect(span?.attributes).not.toHaveProperty("graphql.document");
  });

  it("attaches graphql.document with inline literals redacted when enabled", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        includeDocument: true,
      }),
      successLink({ data: { employee: { name: "x" } } }),
    ]);

    await runOperation(link, { query: QUERY_WITH_INLINE_LITERAL });

    const [span] = harness.spans();
    const document = span?.attributes["graphql.document"] as string;
    expect(document).toContain("employee");
    // Inline string / numeric literals must not leak.
    expect(document).not.toContain("secret@example.com");
    expect(document).not.toContain("5");
  });

  it("ends a subscription span at the first emission", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      streamingLink([
        { data: { tick: 1 } },
        { data: { tick: 2 } },
        { data: { tick: 3 } },
      ]),
    ]);

    const subscriptionDoc = gql`
      subscription OnTick {
        tick
      }
    `;

    const outcome = await runOperation(link, { query: subscriptionDoc });

    // All emissions are forwarded, but a single span is produced and it ends
    // at the first emission.
    expect(outcome.results).toHaveLength(3);
    const spans = harness.spans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("subscription OnTick");
    expect(spans[0]?.attributes["graphql.operation.type"]).toBe("subscription");
  });

  it("ends the span with apollo.canceled when unsubscribed before settling", () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      neverEmitsLink(),
    ]);

    const subscription = execute(link, { query: QUERY }).subscribe({
      next: () => {},
      error: () => {},
      complete: () => {},
    });

    // Nothing has emitted yet, so the span is still open.
    expect(harness.spans()).toHaveLength(0);

    subscription.unsubscribe();

    const [span] = harness.spans();
    expect(span).toBeDefined();
    expect(span?.name).toBe("query GetEmployees");
    expect(span?.attributes["apollo.canceled"]).toBe(true);
    // Cancellation is not an error.
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    expect(span?.attributes["error.type"]).toBeUndefined();
  });

  it("injects W3C traceparent into operation headers by default", async () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    let capturedHeaders: Record<string, string> | undefined;
    const captureLink = new ApolloLink((operation) => {
      capturedHeaders = operation.getContext().headers as Record<string, string>;
      return Observable.of({ data: { employees: [] } });
    });

    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      captureLink,
    ]);

    await runOperation(link, { query: QUERY });

    expect(capturedHeaders?.traceparent).toBeDefined();
    const [span] = harness.spans();
    const traceId = span?.spanContext().traceId;
    expect(capturedHeaders?.traceparent).toContain(traceId);
  });

  it("does not inject traceparent when injectTraceContext=false", async () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());

    let capturedHeaders: Record<string, string> | undefined;
    const captureLink = new ApolloLink((operation) => {
      capturedHeaders = operation.getContext().headers as Record<string, string>;
      return Observable.of({ data: { employees: [] } });
    });

    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        injectTraceContext: false,
      }),
      captureLink,
    ]);

    await runOperation(link, { query: QUERY });

    expect(capturedHeaders?.traceparent).toBeUndefined();
  });
});
