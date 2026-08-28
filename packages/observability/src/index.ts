import { createHash } from "node:crypto";
import {
  context,
  metrics,
  propagation,
  trace,
  type Attributes,
} from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Telemetry } from "@pirh/application";
import { redactError, redactUnknown, tenantSafeId } from "@pirh/redaction";
import pino, { type Logger as PinoLogger } from "pino";

type AttributeValue = string | number | boolean;
type Fields = Readonly<Record<string, unknown>>;

export interface RuntimeLogger {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  child(fields: Fields): RuntimeLogger;
}
export interface TelemetryRuntime {
  readonly telemetry: Telemetry;
  readonly logger: RuntimeLogger;
  /** Flushes buffered telemetry without closing the reusable Lambda runtime. */
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}
function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}
function safeAttributes(
  input: Readonly<Record<string, AttributeValue>> = {},
): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      /^(?:event|delivery|attempt|correlation|trace|tenant)(?:Id)?$/i.test(key)
    )
      continue;
    if (key === "destination")
      result.destination = hashId("dst", String(value));
    else result[key] = value;
  }
  return result;
}
function safeSpanAttributes(
  input: Readonly<Record<string, AttributeValue>> = {},
): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "tenantId") result.tenantIdHash = tenantSafeId(String(value));
    else if (key === "destination")
      result.destination = hashId("dst", String(value));
    else result[key] = value;
  }
  return result;
}
function activeTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}
export function currentTraceparent(): string | undefined {
  return activeTraceparent();
}
function spanFields(): Fields {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  return spanContext?.traceId === undefined
    ? {}
    : { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
function levelSeverity(level: "info" | "warn" | "error"): SeverityNumber {
  return level === "error"
    ? SeverityNumber.ERROR
    : level === "warn"
      ? SeverityNumber.WARN
      : SeverityNumber.INFO;
}
class PinoRuntimeLogger implements RuntimeLogger {
  public constructor(
    private readonly logger: PinoLogger,
    private readonly otelLogger?: ReturnType<LoggerProvider["getLogger"]>,
  ) {}
  public child(fields: Fields): RuntimeLogger {
    return new PinoRuntimeLogger(
      this.logger.child(redactUnknown(fields) as object),
      this.otelLogger,
    );
  }
  public info(message: string, fields: Fields = {}): void {
    this.write("info", message, fields);
  }
  public warn(message: string, fields: Fields = {}): void {
    this.write("warn", message, fields);
  }
  public error(message: string, fields: Fields = {}): void {
    this.write("error", message, fields);
  }
  private write(
    level: "info" | "warn" | "error",
    message: string,
    fields: Fields,
  ): void {
    const normalized = redactUnknown({ ...fields, ...spanFields() }) as Record<
      string,
      unknown
    >;
    if (typeof normalized.tenantId === "string") {
      normalized.tenantIdHash = tenantSafeId(normalized.tenantId);
      delete normalized.tenantId;
    }
    if (fields.error !== undefined)
      normalized.error = redactError(fields.error);
    this.logger[level](normalized, message);
    this.otelLogger?.emit({
      severityNumber: levelSeverity(level),
      severityText: level.toUpperCase(),
      body: message,
      attributes: normalized as Attributes,
      context: context.active(),
    });
  }
}
export function withSpan<T>(
  name: string,
  attributes: Readonly<Record<string, AttributeValue>>,
  action: () => Promise<T> | T,
): Promise<T> | T {
  return trace.getTracer("pirh").startActiveSpan(name, async (span) => {
    span.setAttributes(safeSpanAttributes(attributes));
    try {
      return await action();
    } catch (error) {
      span.recordException(
        error instanceof Error ? error : new Error("unknown"),
      );
      throw error;
    } finally {
      span.end();
    }
  });
}
export function addTraceAttributes(
  attributes: Readonly<Record<string, AttributeValue>>,
): void {
  trace
    .getSpan(context.active())
    ?.setAttributes(safeSpanAttributes(attributes));
}
export function withExtractedTrace<T>(
  traceparent: string | undefined,
  name: string,
  attributes: Readonly<Record<string, AttributeValue>>,
  action: () => Promise<T> | T,
): Promise<T> | T {
  const extracted =
    traceparent === undefined
      ? context.active()
      : propagation.extract(context.active(), { traceparent });
  return context.with(extracted, () => withSpan(name, attributes, action));
}
export function createTelemetryRuntime(input: {
  readonly service: string;
  readonly environment: string;
  readonly otlpEndpoint?: string | undefined;
  readonly logLevel?: string | undefined;
}): TelemetryRuntime {
  const resource = resourceFromAttributes({
    "service.name": input.service,
    "deployment.environment.name": input.environment,
  });
  const endpoint = input.otlpEndpoint?.replace(/\/$/, "");
  const spanProcessor =
    endpoint === undefined || endpoint.length === 0
      ? undefined
      : new BatchSpanProcessor(
          new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
          { scheduledDelayMillis: 500 },
        );
  const metricReader =
    endpoint === undefined || endpoint.length === 0
      ? undefined
      : new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
          exportIntervalMillis: 1_000,
        });
  const sdk =
    endpoint === undefined || endpoint.length === 0
      ? undefined
      : new NodeSDK({
          resource,
          spanProcessors: spanProcessor === undefined ? [] : [spanProcessor],
          ...(metricReader === undefined ? {} : { metricReader }),
        });
  sdk?.start();
  const logProvider =
    endpoint === undefined || endpoint.length === 0
      ? undefined
      : new LoggerProvider({
          resource,
          processors: [
            new BatchLogRecordProcessor({
              exporter: new OTLPLogExporter({ url: `${endpoint}/v1/logs` }),
              scheduledDelayMillis: 500,
            }),
          ],
        });
  const meter = metrics.getMeter("pirh");
  const counters = new Map<string, ReturnType<typeof meter.createCounter>>();
  const durations = new Map<string, ReturnType<typeof meter.createHistogram>>();
  const gauges = new Map<
    string,
    ReturnType<typeof meter.createUpDownCounter>
  >();
  const telemetry: Telemetry = {
    count(name, value = 1, attributes) {
      let instrument = counters.get(name);
      if (instrument === undefined) {
        instrument = meter.createCounter(name);
        counters.set(name, instrument);
      }
      instrument.add(value, safeAttributes(attributes));
    },
    duration(name, valueMs, attributes) {
      let instrument = durations.get(name);
      if (instrument === undefined) {
        instrument = meter.createHistogram(name, { unit: "ms" });
        durations.set(name, instrument);
      }
      instrument.record(valueMs, safeAttributes(attributes));
    },
    gauge(name, value, attributes) {
      let instrument = gauges.get(name);
      if (instrument === undefined) {
        instrument = meter.createUpDownCounter(name);
        gauges.set(name, instrument);
      }
      instrument.add(value, safeAttributes(attributes));
    },
    traceparent: activeTraceparent,
    traceId: () => trace.getSpan(context.active())?.spanContext().traceId,
  };
  const logger = new PinoRuntimeLogger(
    pino({
      level: input.logLevel ?? "info",
      base: { service: input.service, environment: input.environment },
    }),
    logProvider?.getLogger("pirh"),
  );
  return {
    telemetry,
    logger,
    async flush() {
      await Promise.all(
        [
          spanProcessor?.forceFlush(),
          metricReader?.forceFlush(),
          logProvider?.forceFlush(),
        ].filter((value): value is Promise<void> => value !== undefined),
      );
    },
    async shutdown() {
      await Promise.all(
        [sdk?.shutdown(), logProvider?.shutdown()].filter(Boolean),
      );
    },
  };
}
export const cloudWatchAlarmDefinitions = [
  {
    name: "infrastructure-dlq-depth",
    metric: "ApproximateNumberOfMessagesVisible",
    threshold: 0,
  },
  { name: "outbox-oldest-age", metric: "outbox.oldest_age", threshold: 120 },
  {
    name: "delivery-queue-oldest-age",
    metric: "ApproximateAgeOfOldestMessage",
    threshold: 300,
  },
  { name: "delivery-error-rate", metric: "delivery.failure", threshold: 0.05 },
  { name: "open-circuits", metric: "circuit.open", threshold: 0 },
  {
    name: "product-dead-letter-increase",
    metric: "delivery.dead_lettered",
    threshold: 5,
  },
] as const;
export const dashboardPanels = [
  "API health",
  "Queue and worker health",
  "Delivery outcomes",
  "Outbox health",
  "Circuit and rate limits",
  "Replay outcomes",
  "Structured logs",
] as const;
