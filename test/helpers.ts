import {
  ApolloLink,
  Observable,
  execute,
  gql,
} from "@apollo/client/core";
import type { FetchResult, GraphQLRequest } from "@apollo/client/core";

export { gql };
export {
  createMetricsHarness,
  createTracingHarness,
} from "./otel";
export type { MetricsHarness, TracingHarness } from "./otel";

/** Terminating link that resolves once with the given result. */
export function successLink(result: FetchResult): ApolloLink {
  return new ApolloLink(() => Observable.of(result));
}

/** Terminating link that emits a transport-level (network) error. */
export function networkErrorLink(error: Error): ApolloLink {
  return new ApolloLink(
    () =>
      new Observable<FetchResult>((observer) => {
        observer.error(error);
      }),
  );
}

/**
 * Terminating link that emits multiple results then completes - used to model a
 * subscription-style multi-emission observable.
 */
export function streamingLink(results: FetchResult[]): ApolloLink {
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

/**
 * Terminating link that emits the given results then errors - models a
 * subscription that produces messages before failing.
 */
export function streamingErrorLink(
  results: FetchResult[],
  error: unknown,
): ApolloLink {
  return new ApolloLink(
    () =>
      new Observable<FetchResult>((observer) => {
        for (const result of results) {
          observer.next(result);
        }
        observer.error(error);
      }),
  );
}

/**
 * Terminating link that emits the given results and then stays open (never
 * completes) - models a live subscription the consumer later unsubscribes from.
 */
export function openStreamLink(results: FetchResult[]): ApolloLink {
  return new ApolloLink(
    () =>
      new Observable<FetchResult>((observer) => {
        for (const result of results) {
          observer.next(result);
        }
      }),
  );
}

/** Terminating link whose observable never emits (models a pending request). */
export function neverEmitsLink(): ApolloLink {
  return new ApolloLink(() => new Observable<FetchResult>(() => {}));
}

export interface RunOutcome {
  results: FetchResult[];
  error?: unknown;
}

/** Executes a link chain and resolves when the operation settles. */
export function runOperation(
  link: ApolloLink,
  request: GraphQLRequest,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const results: FetchResult[] = [];
    execute(link, request).subscribe({
      next: (result) => results.push(result),
      error: (error) => resolve({ results, error }),
      complete: () => resolve({ results }),
    });
  });
}
