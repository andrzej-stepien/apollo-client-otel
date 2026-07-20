import { trace } from "@opentelemetry/api";
import type { Meter, Tracer } from "@opentelemetry/api";
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

/** How subscription operations are traced. */
export type SubscriptionMode = "first-emission" | "session";

/** Tunables for subscription tracing. See {@link OpenTelemetryLinkOptions.subscriptions}. */
export interface SubscriptionOptions {
  /**
   * `"first-emission"` (default) ends the subscription span at the first
   * message, matching query/mutation behaviour. `"session"` keeps the span open
   * for the whole subscription, adding a span event per message (without any
   * payload) until it completes, errors, or is unsubscribed.
   *
   * @default "first-emission"
   */
  mode?: SubscriptionMode;

  /**
   * Maximum number of per-message span events recorded in `"session"` mode.
   * Once exceeded, further messages are still counted
   * (`apollo.subscription.message_count`) but add no events, and
   * `apollo.subscription.events_truncated` is set to `true`.
   *
   * @default 100
   */
  maxEvents?: number;
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

  /**
   * Predicate deciding whether an operation should be traced. Return `false` to
   * forward the operation untraced (no span, no metrics), for example to drop
   * health-check or polling operations.
   *
   * Receives the raw Apollo operation. When omitted, every operation is traced
   * (subject to `skipIntrospection`).
   */
  shouldTrace?: (operation: Operation) => boolean;

  /**
   * Meter used to record operation metrics. Providing a meter enables metrics.
   *
   * Emits the `graphql.client.operation.duration` histogram (seconds) and the
   * `graphql.client.operation.errors` counter. Takes precedence over
   * {@link enableMetrics}.
   */
  meter?: Meter;

  /**
   * When `true` (and no explicit {@link meter} is given), enables metrics using
   * the global meter provider (`metrics.getMeter("apollo-client-otel")`).
   *
   * Metrics are fully opt-in: with both `meter` and `enableMetrics` unset, no
   * instruments are created and there is zero per-operation cost.
   *
   * @default false
   */
  enableMetrics?: boolean;

  /**
   * Subscription tracing behaviour. By default (`mode: "first-emission"`) a
   * subscription span ends at the first message, exactly as in earlier
   * releases. Set `mode: "session"` to keep one span open for the whole
   * subscription, with a payload-free span event per message (capped by
   * `maxEvents`, default 100).
   *
   * This only affects operations of type `subscription`; queries and mutations
   * behave identically regardless of this option.
   */
  subscriptions?: SubscriptionOptions;
}

export interface ResolvedOptions {
  tracer: Tracer;
  spanNameFormatter?: (context: SpanNameContext) => string;
  includeDocument: boolean;
  injectTraceContext: boolean;
  skipIntrospection: boolean;
  graphQLErrorsAsSpanError: boolean;
  shouldTrace?: (operation: Operation) => boolean;
  meter?: Meter;
  enableMetrics: boolean;
  subscriptions: { mode: SubscriptionMode; maxEvents: number };
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
    shouldTrace: options.shouldTrace,
    meter: options.meter,
    enableMetrics: options.enableMetrics ?? false,
    subscriptions: {
      mode: options.subscriptions?.mode ?? "first-emission",
      maxEvents: options.subscriptions?.maxEvents ?? 100,
    },
  };
}
