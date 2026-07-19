export { createOpenTelemetryLink } from "./link";
export type {
  OpenTelemetryLinkOptions,
  ResolvedOptions,
  SpanNameContext,
} from "./options";
export { TRACER_NAME } from "./options";
export type { GraphQLOperationType } from "./attributes";
export {
  ATTR_APOLLO_CANCELED,
  ATTR_APOLLO_HAS_GRAPHQL_ERRORS,
  ATTR_ERROR_TYPE,
  ATTR_GRAPHQL_DOCUMENT,
  ATTR_GRAPHQL_OPERATION_NAME,
  ATTR_GRAPHQL_OPERATION_TYPE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
} from "./attributes";
