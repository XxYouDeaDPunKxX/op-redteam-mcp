import type { ReviewExecution, ReviewPacket } from "./contracts/types";
import type { Env } from "./env";
import { packetIdHash, subjectHash } from "./security/identity";
import type { ProviderUsage } from "./providers/common";
import type { SparringToolName } from "./sparring/request";

export interface TelemetryInput {
  requestId: string;
  githubUserId: number;
  packet?: Partial<ReviewPacket>;
  packetSizeBytes?: number;
  execution: ReviewExecution;
  totalLatencyMs: number;
  rateLimited: boolean;
}

export async function emitTelemetry(env: Env, input: TelemetryInput): Promise<void> {
  try {
    const [hashedSubject, hashedPacketId] = await Promise.all([
      subjectHash(env.IDENTITY_HMAC_KEY, input.githubUserId),
      packetIdHash(env.IDENTITY_HMAC_KEY, input.packet?.packet_id ?? "unknown"),
    ]);
    const gateCodes = input.execution.output.gate_errors.map((error) => error.code).join(",");
    env.ANALYTICS.writeDataPoint({
      indexes: [input.requestId, hashedSubject],
      blobs: [
        hashedPacketId,
        input.packet?.packet_version ?? "unknown",
        input.packet?.mode ?? "unknown",
        input.execution.output.gate_status,
        gateCodes,
        input.execution.execution_phase,
        input.execution.critic_called ? "true" : "false",
        input.rateLimited ? "true" : "false",
        env.VERSION_METADATA?.id ?? "local",
      ],
      doubles: [
        input.packetSizeBytes ?? 0,
        input.execution.critic_latency_ms ?? 0,
        input.totalLatencyMs,
        input.execution.input_tokens ?? 0,
        input.execution.cached_input_tokens ?? 0,
        input.execution.output_tokens ?? 0,
      ],
    });
  } catch {
    // Telemetry is best-effort and must never change a review result.
  }
}

export interface SparringTelemetryInput {
  requestId: string;
  githubUserId: number;
  tool: SparringToolName;
  outcome: string;
  diagnostic?: string;
  providerLatencyMs: number;
  totalLatencyMs: number;
  usage?: ProviderUsage;
}

export async function emitSparringTelemetry(env: Env, input: SparringTelemetryInput): Promise<void> {
  try {
    const hashedSubject = await subjectHash(env.IDENTITY_HMAC_KEY, input.githubUserId);
    env.ANALYTICS.writeDataPoint({
      indexes: [input.requestId, hashedSubject],
      blobs: [input.tool, input.outcome, env.VERSION_METADATA?.id ?? "local", input.diagnostic ?? "none"],
      doubles: [
        input.providerLatencyMs,
        input.totalLatencyMs,
        input.usage?.input_tokens ?? 0,
        input.usage?.cached_input_tokens ?? 0,
        input.usage?.output_tokens ?? 0,
      ],
    });
  } catch {
    // Telemetry is best-effort and must never change a tool result.
  }
}
