import {
  FREE_MODEL_BUDGETS,
  type FreeModelBudget,
} from "../../config/freeModelCatalog.ts";
import { SYNTHETIC_NOAUTH_CONNECTION_ID } from "./resilienceCandidateFilter.ts";

const KEYLESS_FREE_TYPES = new Set<FreeModelBudget["freeType"]>(["keyless"]);

export type FreeAccessStatus = "SAFE" | "EXHAUSTED" | "UNKNOWN";

export interface FreeAccessState {
  status: FreeAccessStatus;
  remainingFreeAllowance: number | null;
  resetAt: string | null;
  checkedAt: string;
}

export interface StrictZeroCostCandidate {
  provider: string;
  model: string;
  connectionId: string | null;
  allowedConnectionIds?: string[];
}

export interface StrictZeroCostOptions {
  enabled: boolean;
  resolveFreeAccessState: (
    provider: string,
    connectionId: string
  ) => FreeAccessState | undefined;
  minRemainingAllowance: number;
  maxStateAgeMs: number;
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

function isConnectionStateSafe(
  provider: string,
  connectionId: string,
  resolveFreeAccessState: StrictZeroCostOptions["resolveFreeAccessState"],
  options: Pick<StrictZeroCostOptions, "minRemainingAllowance" | "maxStateAgeMs" | "now">
): boolean {
  const state = resolveFreeAccessState(provider, connectionId);
  if (!state || state.status !== "SAFE") return false;

  const checkedAtMs = Date.parse(state.checkedAt);
  const now = (options.now ?? Date.now)();
  if (!Number.isFinite(checkedAtMs) || now - checkedAtMs > options.maxStateAgeMs) return false;
  if (state.remainingFreeAllowance === null) return false;
  if (options.minRemainingAllowance < 0) return false;

  return state.remainingFreeAllowance > options.minRemainingAllowance;
}

export function evaluateCandidateConnections(
  candidate: StrictZeroCostCandidate,
  budgetEntry: FreeModelBudget | undefined,
  resolveFreeAccessState: StrictZeroCostOptions["resolveFreeAccessState"],
  options: Pick<StrictZeroCostOptions, "minRemainingAllowance" | "maxStateAgeMs" | "now">
): string[] {
  if (!budgetEntry) return [];

  const isGenuineNoAuthCandidate =
    candidate.connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID;

  if (KEYLESS_FREE_TYPES.has(budgetEntry.freeType) && isGenuineNoAuthCandidate) {
    return [SYNTHETIC_NOAUTH_CONNECTION_ID];
  }

  if (budgetEntry.freeType === "discontinued") return [];
  if (isGenuineNoAuthCandidate) return [];
  if (budgetEntry.hardStopGuaranteed !== true) return [];

  const candidateConnectionIds = candidate.connectionId
    ? [candidate.connectionId]
    : candidate.allowedConnectionIds ?? [];

  const safeConnectionIds: string[] = [];
  for (const connectionId of candidateConnectionIds) {
    if (connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID) continue;
    if (
      isConnectionStateSafe(
        candidate.provider,
        connectionId,
        resolveFreeAccessState,
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
      options.resolveFreeAccessState,
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
