import type { Operation } from "@apollo/client/core";

export interface ServerAddress {
  address: string;
  port?: number;
}

/**
 * Best-effort extraction of the target endpoint from the Apollo link context.
 *
 * Apollo's `HttpLink` reads a `uri` from the operation context (or a static
 * option). When present and absolute we return the host (and port); relative
 * URIs such as `/graphql` are returned verbatim as the address. A function
 * `uri` cannot be resolved here and is ignored.
 */
export function resolveServerAddress(
  operation: Operation,
): ServerAddress | undefined {
  const context = operation.getContext();
  const uri = (context as { uri?: unknown }).uri;

  if (typeof uri !== "string" || uri.length === 0) {
    return undefined;
  }

  try {
    const url = new URL(uri);
    const result: ServerAddress = { address: url.hostname };
    if (url.port) {
      result.port = Number(url.port);
    }
    return result;
  } catch {
    // Relative URI (e.g. "/graphql") - expose it as-is.
    return { address: uri };
  }
}
