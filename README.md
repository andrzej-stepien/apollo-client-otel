# apollo-client-otel

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

- `@apollo/client` (`^3.0.0`)
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
| `error.type` | Network error class name, or `graphql_error`. |

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

Example with a plan-style name and document capture:

```ts
createOpenTelemetryLink({
  spanNameFormatter: ({ operationType, operationName }) =>
    `graphql.${operationType}.${operationName}`,
  includeDocument: true,
});
```

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
  wrapper over `watchQuery`) and is out of scope for 0.1.
- **Browser context propagation is not automatic.** Without a `ZoneContextManager`
  (zone.js), the active span does not survive the async hop to `fetch`, so an
  instrumented `fetch` may not nest as a child span. The default
  `injectTraceContext` sidesteps this by putting `traceparent` on the request
  headers, giving you frontend → backend correlation even without zone.js and
  without fetch instrumentation.
- **Subscriptions are traced up to the first emission only.** The span covers
  establishment through the first message, then ends - a long-lived span is an
  anti-pattern for trace backends. Subsequent emissions are forwarded untraced.
  Full streaming / `graphql-ws` support is planned for a later release.
- **`BatchHttpLink` shares HTTP timing across operations.** A span per operation
  is still correct, but the transport timing is shared by every operation batched
  into the same HTTP request.

## Apollo Client 4

This release targets **Apollo Client 3** (`peerDependency ^3.0.0`). Apollo
Client 4 reworked the error model (e.g. `CombinedGraphQLErrors`) and package
structure; declaring `>=3` without testing against v4 would be an unbacked
promise. The code uses feature detection rather than internal imports, but v4
support is deferred to a future release and tracked separately.

## Roadmap

- **0.2** - cache hit/miss (via a non-link mechanism), GraphQL error counts,
  retry timing, persisted queries, document anonymization, `shouldTrace`
  callback, per-operation sampler.
- **0.3** - Grafana Faro integration, Sentry adapter, correlation IDs from the
  response, upload instrumentation, `graphql-ws` support.

## License

[MIT](./LICENSE)
