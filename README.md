# apollo-client-otel

[![npm](https://img.shields.io/npm/v/apollo-client-otel)](https://www.npmjs.com/package/apollo-client-otel)

OpenTelemetry instrumentation for [Apollo Client](https://www.apollographql.com/docs/react/)
that understands **GraphQL operations**, not just the underlying `fetch` request.

It ships as a plain [`ApolloLink`](https://www.apollographql.com/docs/react/api/link/introduction/):
drop it into your link chain and get one span per Apollo operation, with safe,
semantic-convention attributes and W3C trace-context propagation to your backend.

## The problem

Generic OpenTelemetry HTTP instrumentation shows you a `POST /graphql` span with
no idea which operation ran, whether it returned GraphQL errors, or how it maps
to your app. Server-side GraphQL instrumentation, on the other hand, can be far
too granular (per-resolver spans). There is currently **no first-party Apollo
Client instrumentation** in the OpenTelemetry ecosystem:

- [opentelemetry-js-contrib#3609](https://github.com/open-telemetry/opentelemetry-js-contrib/issues/3609)
  - request for planned Apollo Client instrumentation.
- [opentelemetry-js-contrib#1739](https://github.com/open-telemetry/opentelemetry-js-contrib/issues/1739)
  - related client-side GraphQL tracing gap.

This library fills that niche at the operation level.

## Installation

```bash
npm install apollo-client-otel
```

`apollo-client-otel` has **zero runtime dependencies**. The following are
`peerDependencies` you already have (or configure) in an OTel-instrumented Apollo
app:

- `@apollo/client` (`^3.0.0 || ^4.0.0`) - works with both Apollo Client 3 and 4
- `@opentelemetry/api` (`>=1.0.0`)
- `graphql` (`>=15.0.0`)

## Quick start

```ts
import { ApolloClient, InMemoryCache, HttpLink, from } from "@apollo/client";
import { createOpenTelemetryLink } from "apollo-client-otel";

const telemetryLink = createOpenTelemetryLink();

const client = new ApolloClient({
  cache: new InMemoryCache(),
  link: from([telemetryLink, new HttpLink({ uri: "https://api.example.com/graphql" })]),
});
```

Place the telemetry link **before** your terminating (HTTP) link so it observes
every operation that leaves the client.

### OpenTelemetry setup

You need a configured OTel SDK. For the `traceparent` header injection (enabled
by default, see below) a **global W3C propagator** must be registered - this is
part of the standard OTel Web/Node SDK setup:

```ts
import { propagation } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

propagation.setGlobalPropagator(new W3CTraceContextPropagator());
```

If no global propagator is set, header injection silently no-ops (spans are still
created locally).

## What you get

For an operation like `query GetEmployees { ... }` you get a span named
`query GetEmployees` (OTel GraphQL semantic-convention format
`<operation.type> <operation.name>`) with:

| Attribute | Notes |
| --- | --- |
| `graphql.operation.name` | Operation name, or `anonymous` for unnamed operations. |
| `graphql.operation.type` | `query` \| `mutation` \| `subscription`. |
| `graphql.document` | Only when `includeDocument: true`. Inline scalar literals are **redacted**. |
| `server.address` / `server.port` | Derived from the operation-context `uri` when available. |
| `apollo.has_graphql_errors` | `true` when the response contains GraphQL errors. |
| `apollo.graphql_error_count` | Number of GraphQL errors, set only when there is at least one. |
| `error.type` | Network error class name, `graphql_error`, or the combined-error class name (e.g. `CombinedGraphQLErrors` on Apollo Client 4). |
| `apollo.persisted_query` / `apollo.persisted_query.hash` | Set for Automatic Persisted Queries. The hash is the sha256 of the query text (no request data). See [Persisted queries](#persisted-queries). |
| `apollo.retry_count` | Best-effort retry count read from `context.retryCount`. See [Retry count](#retry-count). |

Span status is `OK` on success, `ERROR` on a network failure (with
`recordException`) or on GraphQL errors (configurable). If the consumer
unsubscribes before the operation settles (e.g. a React unmount or canceled
query), the span is ended with `apollo.canceled = true` and status left `UNSET`,
so it is still exported rather than leaked.

## API

### `createOpenTelemetryLink(options?): ApolloLink`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `tracer` | `Tracer` | `trace.getTracer("apollo-client-otel")` | Tracer used to create spans. |
| `spanNameFormatter` | `(ctx) => string` | `` `${type} ${name}` `` | Custom span name. `ctx` is `{ operationName, operationType, operation }`. |
| `includeDocument` | `boolean` | `false` | Attach the printed document as `graphql.document`, with inline scalar literals redacted. |
| `injectTraceContext` | `boolean` | `true` | Inject W3C `traceparent`/`tracestate` into operation headers. |
| `skipIntrospection` | `boolean` | `true` | Do not create spans for introspection operations. |
| `graphQLErrorsAsSpanError` | `boolean` | `true` | Set span status `ERROR` when the response carries GraphQL errors. |
| `shouldTrace` | `(operation) => boolean` | trace all | Return `false` to forward an operation untraced (no span, no metrics). |
| `meter` | `Meter` | - | Provide a meter to enable [metrics](#metrics). Takes precedence over `enableMetrics`. |
| `enableMetrics` | `boolean` | `false` | Enable [metrics](#metrics) using the global meter provider. |
| `subscriptions` | `{ mode?: "first-emission" \| "session"; maxEvents?: number }` | `{ mode: "first-emission", maxEvents: 100 }` | [Subscription](#subscriptions) tracing behaviour. `"session"` keeps one span per subscription with a payload-free event per message (capped by `maxEvents`). Affects `subscription` operations only. |

Example with a plan-style name and document capture:

```ts
createOpenTelemetryLink({
  spanNameFormatter: ({ operationType, operationName }) =>
    `graphql.${operationType}.${operationName}`,
  includeDocument: true,
});
```

### Selective tracing with `shouldTrace`

Skip noisy operations (health checks, polling) without creating spans or metrics:

```ts
createOpenTelemetryLink({
  shouldTrace: (operation) => operation.operationName !== "HealthCheck",
});
```

## Subscriptions

Subscriptions can be traced in two modes, selected with the `subscriptions`
option. **Message payloads are never recorded** in either mode - only counts and
metadata reach spans and events.

### `mode: "first-emission"` (default)

The historical behaviour, unchanged: the span covers subscription establishment
through the **first message**, then ends. Subsequent emissions are forwarded
untraced. This is the safe default for trace backends, which do not expect
long-lived spans. Query and mutation behaviour is identical either way.

### `mode: "session"`

One span stays open for the **whole subscription** and ends on completion, error,
or unsubscribe:

```ts
createOpenTelemetryLink({
  subscriptions: { mode: "session", maxEvents: 100 },
});
```

- Each message adds a span event named `apollo.subscription.message`. The event
  carries **no attributes** - the payload never leaves the client.
- Up to `maxEvents` events are recorded (default `100`). Beyond that, messages
  are still counted but add no events, and `apollo.subscription.events_truncated`
  is set to `true`.
- When the span ends it records `apollo.subscription.message_count` (the total
  number of emissions, including any past `maxEvents`). Messages that carried
  GraphQL errors (`result.errors`) are additionally counted in
  `apollo.subscription.error_message_count` (set only when at least one such
  message occurred).
- Per-message GraphQL errors never change the span status: the span does not
  end per message, so the `graphQLErrorsAsSpanError` gate applies to terminal
  errors only (the error channel, including combined GraphQL errors on Apollo
  Client 4).
- Span status: `OK` on completion **and** on unsubscribe (unsubscribe also sets
  `apollo.canceled = true`); `ERROR` on a subscription error, using the same
  error classification as queries and mutations (including the
  `graphQLErrorsAsSpanError` gate for combined GraphQL errors).
- The duration metric naturally spans the whole session, since the span ends when
  the session does.

`mode: "session"` applies **only to `subscription` operations**. Queries and
mutations always end at the first emission regardless of this option, so enabling
session mode is backward compatible for everything else.

## Metrics

Metrics are **opt-in**. Pass a `meter`, or set `enableMetrics: true` to use the
global meter provider. With both unset, no instruments are created and there is
zero per-operation cost.

```ts
import { metrics } from "@opentelemetry/api";
import { createOpenTelemetryLink } from "apollo-client-otel";

// Either provide a meter explicitly...
createOpenTelemetryLink({ meter: metrics.getMeter("my-app") });

// ...or use the global meter provider:
createOpenTelemetryLink({ enableMetrics: true });
```

Two instruments are emitted:

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `graphql.client.operation.duration` | Histogram | `s` (seconds) | `graphql.operation.name`, `graphql.operation.type`, `error.type` (when errored) |
| `graphql.client.operation.errors` | Counter | - | `graphql.operation.name`, `graphql.operation.type`, `error.type` |

The duration is measured from dispatch to the first result (mirroring the span).
The error counter increments whenever the span is marked `ERROR` (a network
failure, or GraphQL errors when `graphQLErrorsAsSpanError` is `true`).

Enabling metrics requires an `@opentelemetry/api` that includes the metrics API
(`>=1.4`); tracing alone works on any `>=1.0`.

## Persisted queries

When an operation is sent as an
[Automatic Persisted Query](https://www.apollographql.com/docs/apollo-server/performance/apq/)
the span is annotated with `apollo.persisted_query = true` and
`apollo.persisted_query.hash` (the sha256 that identifies the query text - it
carries no request data, so it is safe to record).

The hash is read from `operation.extensions.persistedQuery.sha256Hash` (the field
the standard `createPersistedQueryLink` writes), falling back to the same shape
on the operation context. **Place the telemetry link *after* the persisted-query
link** so the extension is present when the span is created.

## Retry count

If the operation context carries a numeric `retryCount`, it is recorded as
`apollo.retry_count`. This is best-effort: Apollo's `RetryLink` does not expose a
count by default, so the attribute appears only when your app (or a custom retry
link) writes `context.retryCount`.

## Security notes

- **Variables are never recorded** - not even optionally. Variables are the most
  common source of PII in a GraphQL request and stay out of every span.
- **`includeDocument` is `false` by default.** When enabled, the document is
  printed with **inline scalar literals redacted** (string, int, float), so
  values embedded directly in the query text - e.g.
  `where: { email: "a@b.com" }` - do not leak. Field names and structure are
  still exposed, so enable it only if that is acceptable for your data.
- **Header injection is scoped to trace context.** `injectTraceContext` writes
  only the standard `traceparent`/`tracestate` headers; it never adds anything
  derived from your data.

## Limitations

- **Cache-first / cache-only reads never reach the link.** A query fully served
  from the Apollo cache does not travel through the link chain, so **no span is
  created** for it. Cache hit/miss detection needs a different mechanism (a
  wrapper over `watchQuery`) and remains out of scope; it is planned for 0.3.
- **Browser context propagation is not automatic.** Without a `ZoneContextManager`
  (zone.js), the active span does not survive the async hop to `fetch`, so an
  instrumented `fetch` may not nest as a child span. The default
  `injectTraceContext` sidesteps this by putting `traceparent` on the request
  headers, giving you frontend → backend correlation even without zone.js and
  without fetch instrumentation.
- **Subscriptions default to first-emission tracing.** The span covers
  establishment through the first message, then ends - a long-lived span is an
  anti-pattern for trace backends. Opt into full-session tracing (one span per
  subscription, an event per message) with `subscriptions: { mode: "session" }`;
  see [Subscriptions](#subscriptions).
- **`BatchHttpLink` shares HTTP timing across operations.** A span per operation
  is still correct, but the transport timing is shared by every operation batched
  into the same HTTP request.

## Apollo Client 3 and 4

Both major versions are supported (`peerDependency ^3.0.0 || ^4.0.0`). The link
imports only the stable `@apollo/client/core` surface, which exposes the same
symbols in both versions (`ApolloLink`, `Observable`, `execute`, `from`, `gql`,
and the `FetchResult` / `Operation` types). Apollo Client 4 switched its
`Observable` to RxJS; because the link constructs and consumes observables only
through that shared export, it runs unchanged on either implementation.

Apollo Client 4 reworked the error model (GraphQL errors surface as a
`CombinedGraphQLErrors` object on the error channel). Rather than importing that
class - which would tie the library to one major version - the link **detects
the error shape at runtime** (an `Error` carrying an `errors` array) and records
`apollo.has_graphql_errors`, `apollo.graphql_error_count`, and `error.type` from
it. `graphQLErrorsAsSpanError` gates the ERROR status, the recorded exception,
and the metrics error label identically on both versions.

One deliberate difference: with `graphQLErrorsAsSpanError: true` the `error.type`
value is `"graphql_error"` on Apollo Client 3 (errors arrive on the result, with
no error object to name) but the combined-error class name (e.g.
`"CombinedGraphQLErrors"`) on Apollo Client 4, which is more informative. If you
alert or group by `error.type`, account for both values when migrating.

The test suite runs against both versions: the default suite against Apollo
Client 3, and `npm run test:v4` end-to-end against Apollo Client 4 (installed as
an npm alias).

## Roadmap

- **0.2 (this release)** - Apollo Client 4 support, opt-in metrics
  (duration histogram + error counter), `shouldTrace` callback,
  `apollo.graphql_error_count`, best-effort `apollo.retry_count`, and persisted
  query attributes.
- **0.3** - cache hit/miss via a non-link mechanism (a wrapper over
  `watchQuery`), per-operation sampler, Grafana Faro integration, Sentry
  adapter, correlation IDs from the response, upload instrumentation, and full
  `graphql-ws` streaming support.

## License

[MIT](./LICENSE)
