import { afterEach, describe, expect, it, vi } from "vitest";

import type { StandardLogEvent } from "../src/log-sink";
import { createLogSink } from "../src/log-sink";

afterEach(() => {
  vi.useRealTimers();
});

function event(): StandardLogEvent {
  return {
    schemaVersion: "1",
    eventId: "event-123",
    occurredAt: "2026-10-06T20:00:00.000Z",
    source: "op-redteam-mcp",
    subjectHash: "subject-hash",
    tool: "stress_structure",
    runtimeVersion: "3.9.3",
    outcome: "ok",
    providerLatencyMs: 120,
    totalLatencyMs: 180,
    usage: {
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 8,
    },
    request: {
      artifact_excerpt: "artifact",
      target_quote: "target",
      outcome_quote: "outcome",
      attack_lens: "boundary",
      claim_under_test: "claim",
    },
    response: {
      content: [{ type: "text", text: "accepted" }],
      structuredContent: { challenge: "accepted" },
    },
  };
}

const enabledConfig = {
  LOG_SINK_ENABLED: "true",
  LOG_SINK_URL: "https://logs.example.test/ingest",
  LOG_SINK_TOKEN: "sink-token",
};

describe("generic telemetry log sink", () => {
  it("does not fetch when disabled or when enabled configuration is invalid", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const configs = [
      {},
      { ...enabledConfig, LOG_SINK_ENABLED: "false" },
      { ...enabledConfig, LOG_SINK_URL: undefined },
      { ...enabledConfig, LOG_SINK_TOKEN: undefined },
      { ...enabledConfig, LOG_SINK_URL: "not-a-url" },
      { ...enabledConfig, LOG_SINK_URL: "http://logs.example.test/ingest" },
    ];

    for (const config of configs) {
      const result = await createLogSink(config, fetcher).emit(event());
      expect(result.status).not.toBe("delivered");
    }

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("posts exactly the approved event body with bearer authentication", async () => {
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedInput = input;
      capturedInit = init;
      return new Response(null, { status: 204 });
    });

    const result = await createLogSink(enabledConfig, fetcher).emit(event());
    expect(result).toEqual({ status: "delivered" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(capturedInput).toBe(enabledConfig.LOG_SINK_URL);
    expect(capturedInit?.method).toBe("POST");
    expect(new Headers(capturedInit?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(capturedInit?.headers).get("authorization")).toBe("Bearer sink-token");

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "eventId",
      "occurredAt",
      "outcome",
      "providerLatencyMs",
      "request",
      "response",
      "runtimeVersion",
      "schemaVersion",
      "source",
      "subjectHash",
      "tool",
      "totalLatencyMs",
      "usage",
    ]);
    expect(body).toEqual(event());
  });

  it("classifies a rejected fetch without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network down"));

    const result = await createLogSink(enabledConfig, fetcher).emit(event());

    expect(result).toEqual({ status: "failed", reason: "network_error" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(enabledConfig.LOG_SINK_TOKEN);
    expect(JSON.stringify(result)).not.toContain(enabledConfig.LOG_SINK_URL);
  });

  it("classifies a non-success response without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));

    const result = await createLogSink(enabledConfig, fetcher).emit(event());

    expect(result).toEqual({ status: "failed", reason: "http_error" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a hanging request at the delivery timeout without retrying", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }));

    const pending = createLogSink(enabledConfig, fetcher).emit(event());
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;

    expect(result).toEqual({ status: "failed", reason: "timeout" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
