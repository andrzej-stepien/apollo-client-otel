import { trace } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";
import type { Operation } from "@apollo/client/core";
import type { GraphQLOperationType } from "./attributes";

/** Name used when a tracer is not supplied by the caller. */
export const TRACER_NAME = "apollo-client-otel";

/** Context passed to a custom {@link OpenTelemetryLinkOptions.spanNameFormatter}. */
export interface SpanNameContext {
  operationName: string;
  operationType: GraphQLOperationType;
  operation: Operation;
}

export interface OpenTelemetryLinkOptions {
  /**
   * Tracer used to create operation spans.
   * Defaults to `trace.getTracer("apollo-client-otel")`.
   */
  tracer?: Tracer;

  /**
   * Overrides the span name. Receives the resolved operation name/type and the
   * raw Apollo operation.
   *
   * The default follows the OpenTelemetry GraphQL semantic conventions:
   * `<operation.type> <operation.name>` (e.g. `query GetEmployees`). Use this
   * for a custom scheme such as `graphql.query.GetEmployees`.
   */
  spanNameFormatter?: (context: SpanNameContext) => string;

  /**
   * When `true`, attaches the GraphQL document as the `graphql.document`
   * attribute. The document is printed with inline scalar literals (string,
   * int, float) **redacted**, so structure is preserved but values embedded in
   * the query text do not leak. Variables are never attached in any case.
   *
   * Defaults to `false` for data safety.
   *
   * @default false
   */
  includeDocument?: boolean;

  /**
   * When `true`, injects the current span's W3C trace context (`traceparent`,
   * and `tracestate` when present) into `operation` headers via
   * `propagation.inject`.
   *
   * This provides frontend → backend correlation in the browser even without a
   * `ZoneContextManager` / zone.js, where the active context would otherwise
   * not reach `fetch`. Requires a global propagator to be configured by the
   * application (standard OTel setup:
   * `propagation.setGlobalPropagator(new W3CTraceContextPropagator())`).
   *
   * @default true
   */
  injectTraceContext?: boolean;

  /**
   * When `true`, introspection operations (`IntrospectionQuery`, or documents
   * whose root selection targets `__schema` / `__type`) are executed without
   * creating a span.
   *
   * @default true
   */
  skipIntrospection?: boolean;

  /**
   * When `true`, a response that contains GraphQL errors (`result.errors`) sets
   * the span status to `ERROR` in addition to
   * `apollo.has_graphql_errors = true`.
   *
   * Set to `false` if you consider partial/GraphQL errors an expected outcome
   * and only want transport-level (network) failures to mark spans as errored.
   *
   * @default true
   */
  graphQLErrorsAsSpanError?: boolean;
}

export interface ResolvedOptions {
  tracer: Tracer;
  spanNameFormatter?: (context: SpanNameContext) => string;
  includeDocument: boolean;
  injectTraceContext: boolean;
  skipIntrospection: boolean;
  graphQLErrorsAsSpanError: boolean;
}

export function resolveOptions(
  options: OpenTelemetryLinkOptions = {},
): ResolvedOptions {
  return {
    tracer: options.tracer ?? trace.getTracer(TRACER_NAME),
    spanNameFormatter: options.spanNameFormatter,
    includeDocument: options.includeDocument ?? false,
    injectTraceContext: options.injectTraceContext ?? true,
    skipIntrospection: options.skipIntrospection ?? true,
    graphQLErrorsAsSpanError: options.graphQLErrorsAsSpanError ?? true,
  };
}
