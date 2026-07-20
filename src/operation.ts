import { getOperationAST, print, visit } from "graphql";
import type { DocumentNode, OperationDefinitionNode } from "graphql";
import type { Operation } from "@apollo/client/core";
import type { GraphQLOperationType } from "./attributes";

export const ANONYMOUS_OPERATION_NAME = "anonymous";

export interface OperationInfo {
  /** Resolved operation name; `"anonymous"` when the document is unnamed. */
  name: string;
  /** GraphQL operation kind. Defaults to `"query"` when it cannot be derived. */
  type: GraphQLOperationType;
  /** Root operation definition, if one could be resolved from the document. */
  ast: OperationDefinitionNode | null;
}

function resolveOperationDefinition(
  query: DocumentNode,
  operationName: string | undefined,
): OperationDefinitionNode | null {
  // `getOperationAST` picks the named operation, or the single operation when
  // the name is empty. Returns null for documents with multiple anonymous ops.
  return getOperationAST(query, operationName || undefined) ?? null;
}

export function describeOperation(operation: Operation): OperationInfo {
  const ast = resolveOperationDefinition(
    operation.query,
    operation.operationName,
  );

  const name =
    operation.operationName || ast?.name?.value || ANONYMOUS_OPERATION_NAME;

  const type: GraphQLOperationType = ast?.operation ?? "query";

  return { name, type, ast };
}

/**
 * Default span name following the OpenTelemetry GraphQL semantic conventions:
 * `<operation.type> <operation.name>`, e.g. `query GetEmployees`.
 */
export function defaultSpanName(info: OperationInfo): string {
  return `${info.type} ${info.name}`;
}

/**
 * Detects introspection operations. Matches the conventional
 * `IntrospectionQuery` operation name, and any document whose root selection
 * set targets an introspection meta-field (`__schema`, `__type`).
 */
export function isIntrospectionOperation(
  operation: Operation,
  info: OperationInfo,
): boolean {
  if (operation.operationName === "IntrospectionQuery") {
    return true;
  }

  const selections = info.ast?.selectionSet.selections;
  if (!selections) {
    return false;
  }

  return selections.some(
    (selection) =>
      selection.kind === "Field" && selection.name.value.startsWith("__"),
  );
}

/**
 * Redacts inline scalar literals (string / int / float) from a document so the
 * printed structure can be attached without leaking data embedded directly in
 * the query text (e.g. `where: { email: "a@b.com" }`). Variable references are
 * left untouched; variable *values* are never part of the printed document.
 */
export function redactDocument(query: DocumentNode): DocumentNode {
  return visit(query, {
    StringValue(node) {
      return { ...node, value: "", block: false };
    },
    IntValue(node) {
      return { ...node, value: "0" };
    },
    FloatValue(node) {
      return { ...node, value: "0" };
    },
  });
}

/** Printed document with inline scalar literals redacted. */
export function printRedactedDocument(operation: Operation): string {
  return print(redactDocument(operation.query));
}

/** Details of an Automatic Persisted Query, when the operation carries one. */
export interface PersistedQueryInfo {
  /** APQ document hash (sha256), when available. */
  hash?: string;
}

function readPersistedQueryEntry(
  source: unknown,
): PersistedQueryInfo | undefined {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  const entry = (source as { persistedQuery?: unknown }).persistedQuery;
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const hash = (entry as { sha256Hash?: unknown }).sha256Hash;
  return { hash: typeof hash === "string" ? hash : undefined };
}

/**
 * Detects an Automatic Persisted Query. The standard
 * `createPersistedQueryLink` records `extensions.persistedQuery` on the
 * operation (and mirrors it in context in some setups). We read the sha256 hash
 * from whichever is present.
 *
 * The telemetry link should be placed **after** the persisted-query link for
 * this to observe the hash, since the persisted-query link is what populates
 * `extensions.persistedQuery`. The hash identifies query text only and carries
 * no request data.
 */
export function resolvePersistedQuery(
  operation: Operation,
): PersistedQueryInfo | undefined {
  const fromExtensions = readPersistedQueryEntry(
    (operation as { extensions?: unknown }).extensions,
  );
  if (fromExtensions) {
    return fromExtensions;
  }
  return readPersistedQueryEntry(operation.getContext());
}

/**
 * Best-effort retry count for the operation, read from the operation context
 * field `retryCount` (a plain number). Apollo's `RetryLink` does not expose a
 * count by default; this is populated only when the application or a custom
 * retry link writes `context.retryCount`. Returns `undefined` when absent.
 */
export function resolveRetryCount(operation: Operation): number | undefined {
  const value = (operation.getContext() as { retryCount?: unknown }).retryCount;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
