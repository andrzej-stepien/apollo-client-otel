import { beforeEach, describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
// Under vitest.v4.config.ts these specifiers resolve to Apollo Client 4.
import {
  ApolloLink,
  CombinedGraphQLErrors,
  Observable,
  execute,
  from,
  gql,
} from "@apollo/client/core";
import type { FetchResult, GraphQLRequest } from "@apollo/client/core";

import { createOpenTelemetryLink } from "../../src/index";
import { createTracingHarness } from "../otel";

/**
 * Apollo Client 4's `execute` requires an execute-context carrying the client.
 * Our link never dereferences `operation.client`, so a minimal stub is enough to
 * drive the link chain in isolation.
 */
const executeContext = { client: {} } as never;

function v4SuccessLink(result: FetchResult): ApolloLink {
  return new ApolloLink(
    () =>
      new Observable<FetchResult>((observer) => {
        observer.next(result);
        observer.complete();
      }),
  );
}

function v4ErrorLink(error: unknown): ApolloLink {
  return new ApolloLink(
    () =>
      new Observable<FetchResult>((observer) => {
        observer.error(error);
      }),
  );
}

function v4StreamingLink(results: FetchResult[]): ApolloLink {
  return new ApolloLink(
    () =>
      new Observable<FetchResult>((observer) => {
        for (const result of results) {
          observer.next(result);
        }
        observer.complete();
      }),
  );
}

function runV4(
  link: ApolloLink,
  request: GraphQLRequest,
): Promise<{ results: FetchResult[]; error?: unknown }> {
  return new Promise((resolve) => {
    const results: FetchResult[] = [];
    execute(link, request, executeContext).subscribe({
      next: (result) => results.push(result),
      error: (error) => resolve({ results, error }),
      complete: () => resolve({ results }),
    });
  });
}

const QUERY = gql`
  query GetEmployees {
    employees {
      id
      name
    }
  }
`;

const SUBSCRIPTION = gql`
  subscription OnTick {
    tick
  }
`;

describe("Apollo Client 4 (real package, end-to-end)", () => {
  let harness: ReturnType<typeof createTracingHarness>;
  beforeEach(() => {
    harness = createTracingHarness();
  });

  it("exports the API surface the library relies on", () => {
    expect(typeof ApolloLink).toBe("function");
    expect(typeof Observable).toBe("function");
    expect(typeof execute).toBe("function");
    expect(typeof from).toBe("function");
    expect(typeof CombinedGraphQLErrors).toBe("function");
  });

  it("creates a span for a successful operation", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      v4SuccessLink({ data: { employees: [] } }),
    ]);

    const outcome = await runV4(link, { query: QUERY });
    expect(outcome.results).toHaveLength(1);

    const [span] = harness.spans();
    expect(span?.name).toBe("query GetEmployees");
    expect(span?.attributes["graphql.operation.name"]).toBe("GetEmployees");
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });

  it("flags GraphQL errors delivered on the result", async () => {
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      v4SuccessLink({
        data: null,
        errors: [{ message: "boom" }],
      } as FetchResult),
    ]);

    await runV4(link, { query: QUERY });

    const [span] = harness.spans();
    expect(span?.attributes["apollo.has_graphql_errors"]).toBe(true);
    expect(span?.attributes["apollo.graphql_error_count"]).toBe(1);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("classifies a real CombinedGraphQLErrors on the error channel", async () => {
    const combined = new CombinedGraphQLErrors({
      data: null,
      errors: [{ message: "boom" }, { message: "bang" }],
    });
    const link = from([
      createOpenTelemetryLink({ tracer: harness.tracer }),
      v4ErrorLink(combined),
    ]);

    const outcome = await runV4(link, { query: QUERY });
    expect(outcome.error).toBe(combined);

    const [span] = harness.spans();
    expect(span?.attributes["apollo.has_graphql_errors"]).toBe(true);
    expect(span?.attributes["apollo.graphql_error_count"]).toBe(2);
    expect(span?.attributes["error.type"]).toBe("CombinedGraphQLErrors");
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("respects graphQLErrorsAsSpanError: false for CombinedGraphQLErrors (regression)", async () => {
    // AC3 semantics: with the option off, GraphQL errors never mark the span
    // as an error. The AC4 error-channel branch must behave identically, so a
    // 3 -> 4 migration does not silently change telemetry.
    const combined = new CombinedGraphQLErrors({
      data: null,
      errors: [{ message: "boom" }, { message: "bang" }],
    });
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        graphQLErrorsAsSpanError: false,
      }),
      v4ErrorLink(combined),
    ]);

    const outcome = await runV4(link, { query: QUERY });
    expect(outcome.error).toBe(combined);

    const [span] = harness.spans();
    // GraphQL-error attributes are still recorded...
    expect(span?.attributes["apollo.has_graphql_errors"]).toBe(true);
    expect(span?.attributes["apollo.graphql_error_count"]).toBe(2);
    // ...but the span is not an error and carries no exception.
    expect(span?.status.code).toBe(SpanStatusCode.OK);
    expect(span?.attributes["error.type"]).toBeUndefined();
    expect(span?.events ?? []).toHaveLength(0);
  });

  it("traces a subscription session end-to-end (event per message, count, OK)", async () => {
    const link = from([
      createOpenTelemetryLink({
        tracer: harness.tracer,
        subscriptions: { mode: "session" },
      }),
      v4StreamingLink([{ data: { tick: 1 } }, { data: { tick: 2 } }]),
    ]);

    const outcome = await runV4(link, { query: SUBSCRIPTION });
    expect(outcome.results).toHaveLength(2);

    const [span] = harness.spans();
    expect(span?.name).toBe("subscription OnTick");
    expect(span?.attributes["graphql.operation.type"]).toBe("subscription");
    expect(
      (span?.events ?? []).filter(
        (e) => e.name === "apollo.subscription.message",
      ),
    ).toHaveLength(2);
    expect(span?.attributes["apollo.subscription.message_count"]).toBe(2);
    expect(span?.status.code).toBe(SpanStatusCode.OK);
  });
});
