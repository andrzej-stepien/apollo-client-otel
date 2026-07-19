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

/** GraphQL operation kinds understood by Apollo. */
export type GraphQLOperationType = "query" | "mutation" | "subscription";
