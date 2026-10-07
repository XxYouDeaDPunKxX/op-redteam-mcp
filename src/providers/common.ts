export interface AiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { extraHeaders?: Record<string, string>; signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface ProviderUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export type ProviderAdapterOutcome =
  | { kind: "candidate"; content: string; latencyMs: number; usage?: ProviderUsage }
  | {
      kind: "failure";
      status: "critic_unavailable" | "critic_failed";
      category: string;
      phase: "critic" | "runtime";
      latencyMs: number;
    };

const UNAVAILABLE_CODES = new Map<number, string>([
  [3036, "quota"],
  [3040, "capacity"],
  [3007, "provider_timeout"],
  [3008, "provider_abort"],
]);
const CONFIGURATION_CODES = new Set([5007, 3042, 5019, 5018, 5016, 3023, 3041]);
const INVALID_REQUEST_CODES = new Set([5004, 3039, 3003, 5005, 3006]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function structuredNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

export function normalizeThrown(error: unknown, applicationDeadline: boolean, latencyMs: number): ProviderAdapterOutcome {
  if (applicationDeadline) {
    return { kind: "failure", status: "critic_unavailable", category: "deadline", phase: "runtime", latencyMs };
  }
  const code = structuredNumber(error, "code");
  const status = structuredNumber(error, "status") ?? structuredNumber(error, "statusCode");
  if (code !== undefined) {
    const unavailable = UNAVAILABLE_CODES.get(code);
    if (unavailable) {
      return { kind: "failure", status: "critic_unavailable", category: unavailable, phase: "runtime", latencyMs };
    }
    if (CONFIGURATION_CODES.has(code)) {
      return { kind: "failure", status: "critic_failed", category: "provider_configuration", phase: "runtime", latencyMs };
    }
    if (INVALID_REQUEST_CODES.has(code)) {
      return { kind: "failure", status: "critic_failed", category: "invalid_provider_request", phase: "runtime", latencyMs };
    }
  }
  if (status !== undefined) {
    if (status === 408 || status === 429 || status >= 500) {
      return { kind: "failure", status: "critic_unavailable", category: "provider_unavailable", phase: "runtime", latencyMs };
    }
    if (status >= 400 && status < 500) {
      return { kind: "failure", status: "critic_failed", category: "provider_configuration", phase: "runtime", latencyMs };
    }
  }
  return { kind: "failure", status: "critic_unavailable", category: "provider_unavailable", phase: "runtime", latencyMs };
}
