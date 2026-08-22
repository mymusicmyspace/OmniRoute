import {
  FREE_MODEL_BUDGETS,
  type FreeModelBudget,
} from "../../config/freeModelCatalog.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "./resilienceCandidateFilter.ts";
import {
  evaluateZeroSpendEvidence,
  type ZeroSpendEvidence,
} from "./zeroSpendEvidence.ts";

export interface StrictZeroCostCandidate {
  provider: string;
  model: string;
  connectionId: string | null;
  allowedConnectionIds?: string[];
}

export interface StrictZeroCostOptions {
  enabled: boolean;
  resolveZeroSpendEvidence: (
    provider: string,
    connectionId: string,
    model: string
  ) => ZeroSpendEvidence | undefined;
  minRemainingAllowance: number;
  maxEvidenceAgeMs: number;
  now?: () => number;
  catalog?: readonly FreeModelBudget[];
}

export function findBudgetEntry(
  candidate: Pick<StrictZeroCostCandidate, "provider" | "model">,
  catalog: readonly FreeModelBudget[] = FREE_MODEL_BUDGETS
): FreeModelBudget | undefined {
  return catalog.find(
    (entry) => entry.provider === candidate.provider && entry.modelId === candidate.model
  );
}

function isConnectionEvidenceSafe(
  candidate: Pick<StrictZeroCostCandidate, "provider" | "model">,
  connectionId: string,
  resolveZeroSpendEvidence: StrictZeroCostOptions["resolveZeroSpendEvidence"],
  options: Pick<
    StrictZeroCostOptions,
    "minRemainingAllowance" | "maxEvidenceAgeMs" | "now"
  >
): boolean {
  const evidence = resolveZeroSpendEvidence(
    candidate.provider,
    connectionId,
    candidate.model
  );
  return evaluateZeroSpendEvidence(evidence, {
    nowMs: (options.now ?? Date.now)(),
    maxAgeMs: options.maxEvidenceAgeMs,
    minRemainingAllowance: options.minRemainingAllowance,
  }).safe;
}

export function evaluateCandidateConnections(
  candidate: StrictZeroCostCandidate,
  budgetEntry: FreeModelBudget | undefined,
  resolveZeroSpendEvidence: StrictZeroCostOptions["resolveZeroSpendEvidence"],
  options: Pick<
    StrictZeroCostOptions,
    "minRemainingAllowance" | "maxEvidenceAgeMs" | "now"
  >
): string[] {
  const isGenuineNoAuthCandidate =
    candidate.connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID;

  // A genuine synthetic no-auth route has no user account that can be billed.
  // Curated free-catalog membership is still required so a free-looking name cannot
  // manufacture eligibility, but the catalog's quota shape may be keyless, daily,
  // or uncapped depending on how that public service documents its limits.
  if (isGenuineNoAuthCandidate) {
    if (budgetEntry && budgetEntry.freeType !== "discontinued") {
      return [SYNTHETIC_NOAUTH_CONNECTION_ID];
    }
    return [];
  }

  if (budgetEntry?.freeType === "discontinued") return [];

  // Credentialed routes are intentionally NOT gated on static catalog membership.
  // This is the v2 promotion path: a newly introduced temporary zero-price model can
  // enter Strict immediately when its concrete provider/account/model tuple has fresh,
  // independently verified zero-spend evidence. The evidence resolver is the proof;
  // the catalog is optional metadata, not a whitelist.
  const candidateConnectionIds = candidate.connectionId
    ? [candidate.connectionId]
    : candidate.allowedConnectionIds ?? [];

  const safeConnectionIds: string[] = [];
  for (const connectionId of candidateConnectionIds) {
    if (connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID) continue;
    if (
      isConnectionEvidenceSafe(
        candidate,
        connectionId,
        resolveZeroSpendEvidence,
        options
      )
    ) {
      safeConnectionIds.push(connectionId);
    }
  }

  return safeConnectionIds;
}

export function filterStrictZeroCostCandidates<T extends StrictZeroCostCandidate>(
  pool: T[],
  options: StrictZeroCostOptions
): T[] {
  if (!options.enabled) return pool;

  const kept: T[] = [];
  let changed = false;

  for (const candidate of pool) {
    const budgetEntry = findBudgetEntry(candidate, options.catalog);
    const safeConnectionIds = evaluateCandidateConnections(
      candidate,
      budgetEntry,
      options.resolveZeroSpendEvidence,
      options
    );

    if (safeConnectionIds.length === 0) {
      changed = true;
      continue;
    }

    const isGenuineNoAuthCandidate =
      candidate.connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID;
    const isSingleConnectionCandidate = candidate.connectionId !== null;

    if (isGenuineNoAuthCandidate || isSingleConnectionCandidate) {
      kept.push(candidate);
      continue;
    }

    const original = candidate.allowedConnectionIds ?? [];
    const isSameSet =
      original.length === safeConnectionIds.length &&
      safeConnectionIds.every((id) => original.includes(id));

    if (isSameSet) {
      kept.push(candidate);
    } else {
      changed = true;
      kept.push({ ...candidate, allowedConnectionIds: safeConnectionIds });
    }
  }

  return changed ? kept : pool;
}

export function filterTosAvoidCandidates<T extends StrictZeroCostCandidate>(
  pool: T[],
  excludeTosAvoid: boolean,
  catalog?: readonly FreeModelBudget[]
): T[] {
  if (!excludeTosAvoid) return pool;
  return pool.filter((candidate) => {
    const entry = findBudgetEntry(candidate, catalog);
    return entry?.tos !== "avoid";
  });
}
