import { metrics as metricsApi } from "@opentelemetry/api";
import type { Attributes, Counter, Histogram, Meter } from "@opentelemetry/api";

import {
  ATTR_ERROR_TYPE,
  ATTR_GRAPHQL_OPERATION_NAME,
  ATTR_GRAPHQL_OPERATION_TYPE,
} from "./attributes";
import type { GraphQLOperationType } from "./attributes";
import { TRACER_NAME } from "./options";
import type { ResolvedOptions } from "./options";

/** Metric instrument names emitted by this instrumentation. */
export const METRIC_OPERATION_DURATION = "graphql.client.operation.duration";
export const METRIC_OPERATION_ERRORS = "graphql.client.operation.errors";

/** Data captured for a single settled operation. */
export interface OperationMeasurement {
  durationSeconds: number;
  operationName: string;
  operationType: GraphQLOperationType;
  /** Present when the operation ended in an error state. */
  errorType?: string;
}

/**
 * Records the operation duration histogram and the error counter.
 *
 * Created only when metrics are enabled (an explicit `meter`, or
 * `enableMetrics: true`), so a link with metrics disabled allocates nothing and
 * pays zero runtime cost per operation.
 */
export interface MetricsRecorder {
  record(measurement: OperationMeasurement): void;
}

class MeterMetricsRecorder implements MetricsRecorder {
  private readonly duration: Histogram;
  private readonly errors: Counter;

  constructor(meter: Meter) {
    this.duration = meter.createHistogram(METRIC_OPERATION_DURATION, {
      description:
        "Duration of a GraphQL client operation from dispatch to first result.",
      unit: "s",
    });
    this.errors = meter.createCounter(METRIC_OPERATION_ERRORS, {
      description: "Count of GraphQL client operations that ended in an error.",
    });
  }

  record(measurement: OperationMeasurement): void {
    const attributes: Attributes = {
      [ATTR_GRAPHQL_OPERATION_NAME]: measurement.operationName,
      [ATTR_GRAPHQL_OPERATION_TYPE]: measurement.operationType,
    };
    if (measurement.errorType !== undefined) {
      attributes[ATTR_ERROR_TYPE] = measurement.errorType;
    }

    this.duration.record(measurement.durationSeconds, attributes);

    if (measurement.errorType !== undefined) {
      this.errors.add(1, attributes);
    }
  }
}

/**
 * Builds a {@link MetricsRecorder} from the resolved options, or returns `null`
 * when metrics are disabled. When `enableMetrics` is set without an explicit
 * `meter`, the global meter provider is used (`metrics.getMeter(...)`).
 */
export function createMetricsRecorder(
  config: ResolvedOptions,
): MetricsRecorder | null {
  if (config.meter) {
    return new MeterMetricsRecorder(config.meter);
  }
  if (config.enableMetrics) {
    return new MeterMetricsRecorder(metricsApi.getMeter(TRACER_NAME));
  }
  return null;
}
