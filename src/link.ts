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
  ATTR_APOLLO_HAS_GRAPHQL_ERRORS,
  ATTR_ERROR_TYPE,
  ATTR_GRAPHQL_DOCUMENT,
  ATTR_GRAPHQL_OPERATION_NAME,
  ATTR_GRAPHQL_OPERATION_TYPE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
} from "./attributes";
import { resolveOptions } from "./options";
import type { OpenTelemetryLinkOptions, ResolvedOptions } from "./options";
import {
  defaultSpanName,
  describeOperation,
  isIntrospectionOperation,
  printRedactedDocument,
} from "./operation";
import type { OperationInfo } from "./operation";
import { resolveServerAddress } from "./serverAddress";

function errorTypeOf(error: unknown): string {
  if (error instanceof Error) {
    return error.name || error.constructor.name || "Error";
  }
  return "Error";
}

function hasGraphQLErrors(result: FetchResult): boolean {
  return Array.isArray(result.errors) && result.errors.length > 0;
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
 * headers for reliable frontend → backend correlation.
 *
 * ## Subscriptions
 * A subscription span covers establishment up to the **first emission** only,
 * then ends. Subsequent emissions are forwarded untraced (a long-lived span is
 * an anti-pattern for trace backends). Full streaming support is planned with
 * `graphql-ws` in a later release.
 */
export function createOpenTelemetryLink(
  options: OpenTelemetryLinkOptions = {},
): ApolloLink {
  const config = resolveOptions(options);

  return new ApolloLink((operation, forward) => {
    if (!forward) {
      // No downstream link - nothing to trace, pass through defensively.
      return null;
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

    return traceForward(span, activeContext, config, () => forward(operation));
  });
}

function traceForward(
  span: Span,
  activeContext: Context,
  config: ResolvedOptions,
  forward: () => Observable<FetchResult>,
): Observable<FetchResult> {
  return new Observable<FetchResult>((observer) => {
    let spanEnded = false;

    const endSpan = (): void => {
      spanEnded = true;
      span.end();
    };

    // Keep the operation span active while subscribing/forwarding so any
    // fetch/XHR instrumentation attaches its span as a child of this one.
    const subscription = otelContext.with(activeContext, () =>
      forward().subscribe({
        next: (result) => {
          if (!spanEnded) {
            // Span covers up to the first emission (query/mutation result, or
            // the first subscription message), then ends.
            const graphQLErrors = hasGraphQLErrors(result);
            span.setAttribute(ATTR_APOLLO_HAS_GRAPHQL_ERRORS, graphQLErrors);
            if (graphQLErrors && config.graphQLErrorsAsSpanError) {
              span.setAttribute(ATTR_ERROR_TYPE, "graphql_error");
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: result.errors?.[0]?.message,
              });
            } else {
              span.setStatus({ code: SpanStatusCode.OK });
            }
            endSpan();
          }
          observer.next(result);
        },
        error: (networkError: unknown) => {
          if (!spanEnded) {
            span.setAttribute(ATTR_APOLLO_HAS_GRAPHQL_ERRORS, false);
            span.setAttribute(ATTR_ERROR_TYPE, errorTypeOf(networkError));
            if (networkError instanceof Error) {
              span.recordException(networkError);
            } else {
              span.recordException({ message: String(networkError) });
            }
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message:
                networkError instanceof Error
                  ? networkError.message
                  : String(networkError),
            });
            endSpan();
          }
          observer.error(networkError);
        },
        complete: () => {
          if (!spanEnded) {
            // Completed without any emission.
            span.setAttribute(ATTR_APOLLO_HAS_GRAPHQL_ERRORS, false);
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
        endSpan();
      }
      subscription.unsubscribe();
    };
  });
}
