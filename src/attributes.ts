/**
 * Semantic attribute keys used by this instrumentation.
 *
 * Where an OpenTelemetry semantic convention exists we reuse it
 * (`server.address`, `error.type`). GraphQL/Apollo specific keys follow the
 * `graphql.*` / `apollo.*` namespaces used by the GraphQL semantic conventions
 * and Apollo tooling.
 */
export const ATTR_GRAPHQL_OPERATION_NAME = "graphql.operation.name";
export const ATTR_GRAPHQL_OPERATION_TYPE = "graphql.operation.type";
export const ATTR_GRAPHQL_DOCUMENT = "graphql.document";
export const ATTR_SERVER_ADDRESS = "server.address";
export const ATTR_SERVER_PORT = "server.port";
export const ATTR_ERROR_TYPE = "error.type";
export const ATTR_APOLLO_HAS_GRAPHQL_ERRORS = "apollo.has_graphql_errors";
export const ATTR_APOLLO_CANCELED = "apollo.canceled";

/** Number of GraphQL errors carried in the operation result (only when > 0). */
export const ATTR_APOLLO_GRAPHQL_ERROR_COUNT = "apollo.graphql_error_count";

/**
 * Number of retries observed for the operation, read best-effort from the
 * operation context. See {@link resolveRetryCount} for the exact source.
 */
export const ATTR_APOLLO_RETRY_COUNT = "apollo.retry_count";

/** `true` when the operation is sent as an Automatic Persisted Query (APQ). */
export const ATTR_APOLLO_PERSISTED_QUERY = "apollo.persisted_query";

/**
 * The APQ document hash (sha256). This identifies the query text only and
 * carries no request data, so it is safe to record.
 */
export const ATTR_APOLLO_PERSISTED_QUERY_HASH = "apollo.persisted_query.hash";

/** GraphQL operation kinds understood by Apollo. */
export type GraphQLOperationType = "query" | "mutation" | "subscription";
