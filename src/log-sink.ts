import type { ProviderUsage } from "./providers/common";
import type { SparringInput, SparringToolName } from "./sparring/request";

const DELIVERY_TIMEOUT_MS = 3_000;
export const LOG_SOURCE = "op-redteam-mcp" as const;

export interface StandardLogEvent {
  schemaVersion: "1";
  eventId: string;
  occurredAt: string;
  source: "op-redteam-mcp";
  subjectHash: string;
  tool: SparringToolName;
  runtimeVersion: string;
  outcome: string;
  providerLatencyMs: number;
  totalLatencyMs: number;
  usage?: ProviderUsage;
  request: SparringInput;
  response: Record<string, unknown>;
}

export type LogSinkFailureReason = "invalid_config" | "timeout" | "network_error" | "http_error";

export type LogSinkDelivery =
  | { status: "disabled" }
  | { status: "delivered" }
  | { status: "failed"; reason: LogSinkFailureReason };

export interface LogSink {
  emit(event: StandardLogEvent): Promise<LogSinkDelivery>;
}

export interface LogSinkConfig {
  LOG_SINK_ENABLED?: string;
  LOG_SINK_URL?: string;
  LOG_SINK_TOKEN?: string;
}

const disabledSink: LogSink = {
  async emit(): Promise<LogSinkDelivery> {
    return { status: "disabled" };
  },
};

export function createLogSink(config: LogSinkConfig, fetcher: typeof fetch = fetch): LogSink {
  if (config.LOG_SINK_ENABLED !== "true") return disabledSink;

  const token = config.LOG_SINK_TOKEN?.trim();
  let url: string;
  try {
    const parsed = new URL(config.LOG_SINK_URL ?? "");
    if (parsed.protocol !== "https:") return invalidConfigSink;
    url = parsed.href;
  } catch {
    return invalidConfigSink;
  }
  if (!token) return invalidConfigSink;

  return {
    async emit(event: StandardLogEvent): Promise<LogSinkDelivery> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
      try {
        const response = await fetcher(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(event),
          signal: controller.signal,
        });
        return response.ok ? { status: "delivered" } : { status: "failed", reason: "http_error" };
      } catch {
        return controller.signal.aborted
          ? { status: "failed", reason: "timeout" }
          : { status: "failed", reason: "network_error" };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

const invalidConfigSink: LogSink = {
  async emit(): Promise<LogSinkDelivery> {
    return { status: "failed", reason: "invalid_config" };
  },
};
