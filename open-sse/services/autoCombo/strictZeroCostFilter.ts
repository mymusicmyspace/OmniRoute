import {
  FREE_MODEL_BUDGETS,
  type FreeModelBudget,
} from "../../config/freeModelCatalog.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "./resilienceCandidateFilter.ts";
import {
  evaluateZeroSpendEvidence,
  type ZeroSpendEvidence,
} from "./zeroSpendEvidence.ts";

const KEYLESS_FREE_TYPES = new Set<FreeModelBudget["freeType"]>(["keyless"]);

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
  if (!budgetEntry) return [];

  const isGenuineNoAuthCandidate =
    candidate.connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID;

  if (KEYLESS_FREE_TYPES.has(budgetEntry.freeType) && isGenuineNoAuthCandidate) {
    return [SYNTHETIC_NOAUTH_CONNECTION_ID];
  }

  if (budgetEntry.freeType === "discontinued") return [];
  if (isGenuineNoAuthCandidate) return [];

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
