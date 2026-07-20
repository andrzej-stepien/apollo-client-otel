import {
  SpanStatusCode,
  context as otelContext,
  propagation,
  trace,
} from "@opentelemetry/api";
import type { Attributes, Context, Span } from "@opentelemetry/api";
import { ApolloLink, Observable } from "@apollo/client/core";
import type { FetchResult, Operation } from "@apollo/client/core";

import {
  ATTR_APOLLO_CANCELED,
  ATTR_APOLLO_GRAPHQL_ERROR_COUNT,
  ATTR_APOLLO_HAS_GRAPHQL_ERRORS,
  ATTR_APOLLO_PERSISTED_QUERY,
  ATTR_APOLLO_PERSISTED_QUERY_HASH,
  ATTR_APOLLO_RETRY_COUNT,
  ATTR_APOLLO_SUBSCRIPTION_ERROR_MESSAGE_COUNT,
  ATTR_APOLLO_SUBSCRIPTION_EVENTS_TRUNCATED,
  ATTR_APOLLO_SUBSCRIPTION_MESSAGE_COUNT,
  ATTR_ERROR_TYPE,
  ATTR_GRAPHQL_DOCUMENT,
  ATTR_GRAPHQL_OPERATION_NAME,
  ATTR_GRAPHQL_OPERATION_TYPE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  SUBSCRIPTION_MESSAGE_EVENT,
} from "./attributes";
import { createMetricsRecorder } from "./metrics";
import type { MetricsRecorder } from "./metrics";
import { resolveOptions } from "./options";
import type { OpenTelemetryLinkOptions, ResolvedOptions } from "./options";
import {
  defaultSpanName,
  describeOperation,
  isIntrospectionOperation,
  printRedactedDocument,
  resolvePersistedQuery,
  resolveRetryCount,
} from "./operation";
import type { OperationInfo } from "./operation";
import { resolveServerAddress } from "./serverAddress";

/** Monotonic clock in milliseconds, falling back to `Date.now` when needed. */
const monotonicNow: () => number =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

function errorTypeOf(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor.name || "Error";
  }
  return "Error";
}

/** Number of GraphQL errors on a result, or 0 when there are none. */
function graphQLErrorCount(result: FetchResult): number {
  return Array.isArray(result.errors) ? result.errors.length : 0;
}

/**
 * Duck-types a combined GraphQL error surfaced on the error channel.
 *
 * Apollo Client 4 wraps GraphQL errors from the `errors` field into a
 * `CombinedGraphQLErrors` object (an `Error` subclass carrying an `errors`
 * array). Rather than importing that class - which would couple us to one major
 * version - we detect the shape: an object with an array-valued `errors`
 * property. This also matches similarly shaped custom/aggregate errors.
 */
interface CombinedGraphQLErrorLike {
  errors: readonly unknown[];
  name?: string;
  message?: string;
}

function asCombinedGraphQLError(
  error: unknown,
): CombinedGraphQLErrorLike | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    Array.isArray((error as { errors?: unknown }).errors)
  ) {
    return error as CombinedGraphQLErrorLike;
  }
  return undefined;
}

function spanNameFor(
  config: ResolvedOptions,
  info: OperationInfo,
  operation: Operation,
): string {
  if (config.spanNameFormatter) {
    return config.spanNameFormatter({
      operationName: info.name,
      operationType: info.type,
      operation,
    });
  }
  return defaultSpanName(info);
}

/**
 * Injects the current span's W3C trace context into the operation headers, so
 * the request carries `traceparent` (and `tracestate`) to the backend even when
 * the browser has no zone-based context propagation for `fetch`.
 *
 * Requires a global propagator configured by the app; if none is set the
 * carrier stays empty and headers are left untouched.
 */
function injectTraceContext(operation: Operation, ctx: Context): void {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);

  if (Object.keys(carrier).length === 0) {
    return;
  }

  operation.setContext(
    (previous: Record<string, unknown> = {}): Record<string, unknown> => ({
      ...previous,
      headers: {
        ...((previous.headers as Record<string, string> | undefined) ?? {}),
        ...carrier,
      },
    }),
  );
}

/**
 * Creates an {@link ApolloLink} that emits one OpenTelemetry span per Apollo
 * operation.
 *
 * Place it before the terminating (HTTP) link:
 *
 * ```ts
 * const client = new ApolloClient({
 *   cache,
 *   link: from([createOpenTelemetryLink(), httpLink]),
 * });
 * ```
 *
 * The operation span is made the active context while the request is forwarded,
 * so an instrumented `fetch` will nest its HTTP span as a child. In the browser,
 * where the active context often does not survive the async hop to `fetch`, the
 * `injectTraceContext` option additionally writes `traceparent` into the request
 * headers for reliable frontend -> backend correlation.
 *
 * Works with both Apollo Client 3 and 4: it imports only the stable
 * `@apollo/client/core` surface and detects the v4 error shape at runtime rather
 * than importing version-specific error classes.
 *
 * ## Subscriptions
 * By default a subscription span covers establishment up to the **first
 * emission** only, then ends. Pass `subscriptions: { mode: "session" }` to keep
 * one span open for the whole subscription instead, adding a payload-free span
 * event per message (capped by `maxEvents`) and recording
 * `apollo.subscription.message_count` when it settles. Message payloads never
 * reach spans or events - only counts and metadata are recorded.
 */
export function createOpenTelemetryLink(
  options: OpenTelemetryLinkOptions = {},
): ApolloLink {
  const config = resolveOptions(options);
  const recorder = createMetricsRecorder(config);

  return new ApolloLink((operation, forward) => {
    if (!forward) {
      // No downstream link - nothing to trace. Complete immediately. Returning
      // a completing observable (rather than `null`) keeps the handler's return
      // type valid under both Apollo Client 3 and 4.
      return new Observable<FetchResult>((observer) => observer.complete());
    }

    if (config.shouldTrace && !config.shouldTrace(operation)) {
      return forward(operation);
    }

    const info = describeOperation(operation);

    if (config.skipIntrospection && isIntrospectionOperation(operation, info)) {
      return forward(operation);
    }

    const attributes: Attributes = {
      [ATTR_GRAPHQL_OPERATION_NAME]: info.name,
      [ATTR_GRAPHQL_OPERATION_TYPE]: info.type,
    };

    if (config.includeDocument) {
      attributes[ATTR_GRAPHQL_DOCUMENT] = printRedactedDocument(operation);
    }

    const persisted = resolvePersistedQuery(operation);
    if (persisted) {
      attributes[ATTR_APOLLO_PERSISTED_QUERY] = true;
      if (persisted.hash !== undefined) {
        attributes[ATTR_APOLLO_PERSISTED_QUERY_HASH] = persisted.hash;
      }
    }

    const server = resolveServerAddress(operation);
    if (server) {
      attributes[ATTR_SERVER_ADDRESS] = server.address;
      if (server.port !== undefined && !Number.isNaN(server.port)) {
        attributes[ATTR_SERVER_PORT] = server.port;
      }
    }

    const span = config.tracer.startSpan(spanNameFor(config, info, operation), {
      attributes,
    });
    const activeContext = trace.setSpan(otelContext.active(), span);

    if (config.injectTraceContext) {
      injectTraceContext(operation, activeContext);
    }

    // Session tracing applies only to subscriptions; queries and mutations are
    // unaffected by the `subscriptions` option and keep first-emission timing.
    const sessionMode =
      config.subscriptions.mode === "session" && info.type === "subscription";

    return traceForward(
      { span, activeContext, config, recorder, info, operation, sessionMode },
      () => forward(operation),
    );
  });
}

interface TraceContext {
  span: Span;
  activeContext: Context;
  config: ResolvedOptions;
  recorder: MetricsRecorder | null;
  info: OperationInfo;
  operation: Operation;
  sessionMode: boolean;
}

function traceForward(
  ctx: TraceContext,
  forward: () => Observable<FetchResult>,
): Observable<FetchResult> {
  const { span, activeContext, config, recorder, info, operation, sessionMode } =
    ctx;

  return new Observable<FetchResult>((observer) => {
    let spanEnded = false;
    let messageCount = 0;
    let errorMessageCount = 0;
    let eventsTruncated = false;
    const startedAt = monotonicNow();

    const endSpan = (errorType?: string): void => {
      spanEnded = true;

      if (sessionMode) {
        span.setAttribute(
          ATTR_APOLLO_SUBSCRIPTION_MESSAGE_COUNT,
          messageCount,
        );
        if (errorMessageCount > 0) {
          span.setAttribute(
            ATTR_APOLLO_SUBSCRIPTION_ERROR_MESSAGE_COUNT,
            errorMessageCount,
          );
        }
        if (eventsTruncated) {
          span.setAttribute(ATTR_APOLLO_SUBSCRIPTION_EVENTS_TRUNCATED, true);
        }
      }

      const retryCount = resolveRetryCount(operation);
      if (retryCount !== undefined) {
        span.setAttribute(ATTR_APOLLO_RETRY_COUNT, retryCount);
      }

      span.end();

      if (recorder) {
        recorder.record({
          durationSeconds: (monotonicNow() - startedAt) / 1000,
          operationName: info.name,
          operationType: info.type,
          errorType,
        });
      }
    };

    // Keep the operation span active while subscribing/forwarding so any
    // fetch/XHR instrumentation attaches its span as a child of this one.
    const subscription = otelContext.with(activeContext, () =>
      forward().subscribe({
        next: (result) => {
          if (sessionMode) {
            // Session mode: the span lives until the subscription settles. Each
            // message adds a payload-free event up to `maxEvents`; beyond that
            // messages are only counted and the span is flagged as truncated.
            // Messages carrying GraphQL errors are counted separately; they
            // never change the span status, because the span does not end per
            // message (graphQLErrorsAsSpanError gates terminal errors only).
            messageCount += 1;
            if (graphQLErrorCount(result) > 0) {
              errorMessageCount += 1;
            }
            if (messageCount <= config.subscriptions.maxEvents) {
              span.addEvent(SUBSCRIPTION_MESSAGE_EVENT);
            } else {
              eventsTruncated = true;
            }
            observer.next(result);
            return;
          }
          if (!spanEnded) {
            // Span covers up to the first emission (query/mutation result, or
            // the first subscription message), then ends.
            const errorCount = graphQLErrorCount(result);
            const hasGraphQLErrors = errorCount > 0;
            span.setAttribute(ATTR_APOLLO_HAS_GRAPHQL_ERRORS, hasGraphQLErrors);
            if (hasGraphQLErrors) {
              span.setAttribute(ATTR_APOLLO_GRAPHQL_ERROR_COUNT, errorCount);
            }
            if (hasGraphQLErrors && config.graphQLErrorsAsSpanError) {
              span.setAttribute(ATTR_ERROR_TYPE, "graphql_error");
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: result.errors?.[0]?.message,
              });
              endSpan("graphql_error");
            } else {
              span.setStatus({ code: SpanStatusCode.OK });
              endSpan();
            }
          }
          observer.next(result);
        },
        error: (networkError: unknown) => {
          if (!spanEnded) {
            const combined = asCombinedGraphQLError(networkError);
            if (combined) {
              // Apollo Client 4 surfaces GraphQL errors here as a combined
              // error object rather than on the `next` channel. Mirror the
              // `next`-channel handling: the GraphQL-error attributes are
              // always set, but ERROR status, the recorded exception, and the
              // metrics error type are gated on `graphQLErrorsAsSpanError` -
              // so AC3 -> AC4 migration keeps the same telemetry semantics.
              const errorCount = combined.errors.length;
              span.setAttribute(ATTR_APOLLO_HAS_GRAPHQL_ERRORS, errorCount > 0);
              if (errorCount > 0) {
                span.setAttribute(ATTR_APOLLO_GRAPHQL_ERROR_COUNT, errorCount);
              }
              if (config.graphQLErrorsAsSpanError) {
                const errorType =
                  (typeof combined.name === "string" && combined.name) ||
                  "graphql_error";
                span.setAttribute(ATTR_ERROR_TYPE, errorType);
                recordException(span, networkError);
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message:
                    typeof combined.message === "string"
                      ? combined.message
                      : undefined,
                });
                endSpan(errorType);
              } else {
                span.setStatus({ code: SpanStatusCode.OK });
                endSpan();
              }
            } else {
              const errorType = errorTypeOf(networkError);
              span.setAttribute(ATTR_APOLLO_HAS_GRAPHQL_ERRORS, false);
              span.setAttribute(ATTR_ERROR_TYPE, errorType);
              recordException(span, networkError);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message:
                  networkError instanceof Error
                    ? networkError.message
                    : String(networkError),
              });
              endSpan(errorType);
            }
          }
          observer.error(networkError);
        },
        complete: () => {
          if (!spanEnded) {
            if (!sessionMode) {
              // First-emission mode: completed without any emission.
              span.setAttribute(ATTR_APOLLO_HAS_GRAPHQL_ERRORS, false);
            }
            // Session mode: the subscription ended cleanly - status OK and the
            // message count is recorded by endSpan.
            span.setStatus({ code: SpanStatusCode.OK });
            endSpan();
          }
          observer.complete();
        },
      }),
    );

    return () => {
      // Consumer unsubscribed before the operation settled (e.g. React unmount
      // or a canceled query). End the span so it is exported rather than leaked;
      // cancellation is not an error, so the status stays UNSET.
      if (!spanEnded) {
        span.setAttribute(ATTR_APOLLO_CANCELED, true);
        if (sessionMode) {
          // A canceled subscription session is a normal end-of-life, not an
          // error: mark OK (in addition to apollo.canceled) and record the
          // message count via endSpan.
          span.setStatus({ code: SpanStatusCode.OK });
        }
        endSpan();
      }
      subscription.unsubscribe();
    };
  });
}

function recordException(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
  } else {
    span.recordException({ message: String(error) });
  }
}
