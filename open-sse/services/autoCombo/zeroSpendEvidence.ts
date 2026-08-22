export type ZeroSpendEvidenceKind =
  | "keyless"
  | "hard-free-tier"
  | "free-quota"
  | "promotional-credit"
  | "effective-zero-price"
  | "account-spend-cap";

export type ZeroSpendStatus = "SAFE" | "EXHAUSTED" | "UNKNOWN";

export interface ZeroSpendEvidence {
  status: ZeroSpendStatus;
  kind: ZeroSpendEvidenceKind;
  checkedAt: string;
  expiresAt: string | null;
  remainingFreeAllowance: number | null;
  effectiveInputPrice: number | null;
  effectiveOutputPrice: number | null;
  paidSpendPossible: boolean;
  hardStopVerified: boolean;
  source: string;
  promotional: boolean;
}

export type ZeroSpendExclusionReason =
  | "not_in_free_evidence"
  | "hard_stop_unverified"
  | "usage_unknown"
  | "evidence_stale"
  | "free_allowance_exhausted"
  | "effective_price_nonzero"
  | "paid_fallback_possible"
  | "promotion_expired";

export interface ZeroSpendEvaluationOptions {
  nowMs: number;
  maxAgeMs: number;
  minRemainingAllowance: number;
}

export interface ZeroSpendEvaluation {
  safe: boolean;
  reason: ZeroSpendExclusionReason | null;
}

const ALLOWANCE_KINDS = new Set<ZeroSpendEvidenceKind>([
  "free-quota",
  "promotional-credit",
]);

function deny(reason: ZeroSpendExclusionReason): ZeroSpendEvaluation {
  return { safe: false, reason };
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateZeroSpendEvidence(
  evidence: ZeroSpendEvidence | undefined,
  options: ZeroSpendEvaluationOptions
): ZeroSpendEvaluation {
  if (!evidence || evidence.status === "UNKNOWN") return deny("usage_unknown");
  if (evidence.status === "EXHAUSTED") return deny("free_allowance_exhausted");

  const checkedAtMs = parseTimestamp(evidence.checkedAt);
  if (
    checkedAtMs === null ||
    options.maxAgeMs < 0 ||
    options.nowMs - checkedAtMs > options.maxAgeMs
  ) {
    return deny("evidence_stale");
  }

  const expiresAtMs = parseTimestamp(evidence.expiresAt);
  if (evidence.expiresAt !== null && expiresAtMs === null) return deny("usage_unknown");
  if (expiresAtMs !== null && expiresAtMs <= options.nowMs) {
    return deny("promotion_expired");
  }

  if (evidence.paidSpendPossible && !evidence.hardStopVerified) {
    return deny("paid_fallback_possible");
  }

  if (evidence.kind === "effective-zero-price") {
    if (evidence.effectiveInputPrice !== 0 || evidence.effectiveOutputPrice !== 0) {
      return deny("effective_price_nonzero");
    }
  }

  if (ALLOWANCE_KINDS.has(evidence.kind)) {
    if (evidence.remainingFreeAllowance === null || options.minRemainingAllowance < 0) {
      return deny("usage_unknown");
    }
    if (evidence.remainingFreeAllowance <= options.minRemainingAllowance) {
      return deny("free_allowance_exhausted");
    }
  } else if (
    evidence.remainingFreeAllowance !== null &&
    evidence.remainingFreeAllowance <= options.minRemainingAllowance
  ) {
    return deny("free_allowance_exhausted");
  }

  if (evidence.kind === "account-spend-cap") {
    const hasZeroPrice =
      evidence.effectiveInputPrice === 0 && evidence.effectiveOutputPrice === 0;
    const hasFreeAllowance =
      evidence.remainingFreeAllowance !== null &&
      evidence.remainingFreeAllowance > options.minRemainingAllowance;
    if (!hasZeroPrice && !hasFreeAllowance) return deny("usage_unknown");
  }

  return { safe: true, reason: null };
}
