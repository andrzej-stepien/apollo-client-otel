import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { MetricData, ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { Meter, Tracer } from "@opentelemetry/api";

/**
 * Version-neutral OpenTelemetry test harnesses. These import only the OTel SDKs
 * (no Apollo Client value imports), so they typecheck identically under the
 * Apollo Client 3 and Apollo Client 4 configurations.
 */

export interface TracingHarness {
  tracer: Tracer;
  exporter: InMemorySpanExporter;
  spans: () => ReadableSpan[];
}

export function createTracingHarness(): TracingHarness {
  const exporter = new InMemorySpanExporter();
  // OTel SDK 2.x: processors are constructor options (addSpanProcessor was
  // removed).
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("test");
  return {
    tracer,
    exporter,
    spans: () => exporter.getFinishedSpans(),
  };
}

export interface MetricsHarness {
  meter: Meter;
  /** Collects and flattens the currently recorded metrics. */
  collect: () => Promise<MetricData[]>;
}

export function createMetricsHarness(): MetricsHarness {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    // Large interval: collection is driven explicitly via `collect`.
    exportIntervalMillis: 2 ** 31 - 1,
  });
  const provider = new MeterProvider({ readers: [reader] });
  const meter = provider.getMeter("test");

  return {
    meter,
    collect: async () => {
      const { resourceMetrics }: { resourceMetrics: ResourceMetrics } =
        await reader.collect();
      return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    },
  };
}
