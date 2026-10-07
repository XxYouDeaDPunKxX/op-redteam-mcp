export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PacketMode = "packet_only" | "source_grounded";
export type GateStatus =
  | "schema_invalid"
  | "secret_detected"
  | "unsupported_mode"
  | "insufficient_context"
  | "critic_unavailable"
  | "critic_failed"
  | "unsupported"
  | "risks_found"
  | "checks_required";

export type ExecutionPhase = "preflight" | "critic" | "postflight" | "runtime";

export interface PacketClaim {
  claim_id: string;
  claim_text: string;
  expected_evidence_standard: string;
}

export interface PacketSource {
  source_id: string;
  source_type: string;
  url_or_ref?: string;
  title: string;
  excerpt: string;
  retrieved_at: string;
  retrieval_surface: string;
}

export interface ClaimEvidence {
  claim_id: string;
  source_id: string;
  claimed_relation: "supports" | "contradicts" | "weak_support" | "unknown";
  confidence_reason: string;
}

export interface ReviewPacket {
  packet_version: "1.0";
  packet_id: string;
  mode: PacketMode;
  object_under_review: {
    object_type: string;
    title: string;
    content: string;
  };
  goal: string;
  scope: { in: string[]; out: string[] };
  constraints: string[];
  stakes: "low" | "medium" | "high";
  known_unknowns: string[];
  stop_conditions: string[];
  operator_question: string;
  claims?: PacketClaim[];
  sources?: PacketSource[];
  claim_evidence?: ClaimEvidence[];
}

export interface GateError {
  code:
    | "schema_invalid"
    | "secret_detected"
    | "unsupported_mode"
    | "insufficient_context"
    | "critic_unavailable"
    | "critic_failed";
  reason: string;
  location?: string;
  category?: string;
}

export interface CritiqueOutput {
  output_version: "1.0";
  packet_id: string;
  gate_status: GateStatus;
  gate_errors: GateError[];
  operator_decision_required: true;
  object_under_review: string;
  scope_understood: string[];
  unsupported_claims: Array<{
    claim_id: string;
    reason: string;
    source_ids_used: string[];
    basis: "provided_evidence" | "packet_inference" | "missing_context";
  }>;
  findings: Array<{
    finding_id: string;
    affected_claim_id?: string;
    object_section?: string;
    basis: "provided_evidence" | "packet_inference" | "speculation" | "missing_context";
    source_ids_used: string[];
    severity: "low" | "medium" | "high";
    confidence: "low" | "medium" | "high";
    why_it_matters: string;
    what_result_would_change: string;
  }>;
  source_assessments: Array<{
    claim_id: string;
    source_id: string;
    claimed_relation: "supports" | "contradicts" | "weak_support" | "unknown";
    assessed_relation: "supports" | "contradicts" | "weak_support" | "irrelevant" | "insufficient";
    reason: string;
    basis: "provided_evidence" | "packet_inference" | "missing_context";
  }>;
  minimum_checks: Array<{
    check: string;
    category: "blocking" | "cheap" | "optional";
    why: string;
    what_result_would_change: string;
    owner: "operator" | "caller" | "external_manual" | "unavailable_to_worker";
    blocking: boolean;
  }>;
  what_not_to_conclude: string[];
  next_packet_needed: string[];
}

export interface ReviewExecution {
  output: CritiqueOutput;
  execution_phase: ExecutionPhase;
  critic_called: boolean;
  critic_latency_ms?: number;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

export interface ReviewIdentity {
  github_user_id: number;
  login: string;
}
