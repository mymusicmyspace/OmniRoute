import { AutoComboConfig } from "./engine";
import { MODE_PACKS } from "./modePacks";
import { DEFAULT_WEIGHTS, ScoringWeights } from "./scoring";
import { getCachedProviderConnections } from "@/lib/db/readCache";
import { getSettings } from "@/lib/db/settings";
import { getProviderRegistry } from "./providerRegistryAccessor";
import type { ConnectionFields } from "@/lib/db/encryption";
import { NOAUTH_PROVIDERS } from "@/shared/constants/providers";
import { hasUsableWebSessionCredential } from "@/shared/providers/webSessionCredentials";
import { defaultLogger as log } from "@omniroute/open-sse/utils/logger";
import { getTokenLimit } from "../contextManager";
import {
  createModelCapabilityResolutionSnapshot,
  getResolvedModelCapabilities,
  type ModelCapabilityResolutionSnapshot,
} from "@/lib/modelCapabilities";
import {
  buildAutoCandidateFilter,
  tierToWeightVariant,
  type AutoCategory,
  type AutoTier,
} from "./suffixComposition";
import { classifyTier } from "../tierResolver";
import type { AutoVariant } from "./autoPrefix";
import { buildFamilyCandidateFilter, type ModelFamily } from "./modelFamily";
import { getHiddenModelsByProvider } from "@/models";
import { getSyncedAvailableModelsByConnection, getCustomModels } from "@/lib/db/models";
import { filterPaidOnlyCandidates } from "./paidModelFilter";
import { filterStrictZeroCostCandidates, filterTosAvoidCandidates } from "./strictZeroCostFilter";
import {
  peekZeroSpendEvidence,
  resolveZeroSpendEvidence,
} from "./zeroSpendEvidenceResolver";
import type { ZeroSpendEvidence } from "./zeroSpendEvidence";
import { promotionUrgencyMultiplier } from "./promotionUrgency";
import { isModelExcludedByConnection } from "@/domain/connectionModelRules";
import { filterExcludedCandidates } from "./candidateOverrides";
import { getExcludedConnectionIds } from "@/lib/db/autoCandidateOverrides";
import {
  filterResilienceBlockedCandidates,
  SYNTHETIC_NOAUTH_CONNECTION_ID as RESILIENCE_NOAUTH_CONNECTION_ID,
  type ConnectionResilienceView,
} from "./resilienceCandidateFilter";
import type { ChaosTuning } from "./chaosEngine";

/** #4235 Phase B: optional category/tier overlay for `auto/<category>:<tier>` combos.
 * #6453: optional `family` overlay for `auto/<family>` combos (e.g. `auto/glm`) —
 * mutually exclusive with category/tier, applied instead of them when present. */
export interface AutoComboSpec {
  category?: AutoCategory;
  tier?: AutoTier;
  family?: ModelFamily;
}

/** Once-per-process empty-pool AUTO warns (steady empty is not a metronome). */
const emptyPoolWarned = new Set<string>();

export function warnEmptyAutoPoolOnce(label: string, message: string, _now = Date.now()): boolean {
  if (emptyPoolWarned.has(label)) return false;
  emptyPoolWarned.add(label);
  log.warn("AUTO", message);
  return true;
}

/** Test-only: reset the once-per-label set (also models emptiness reappearing). */
export function resetEmptyAutoPoolWarnStateForTests(): void {
  emptyPoolWarned.clear();
}

/** Minimal connection shape needed for virtual auto-combo factory */
interface VirtualFactoryConn extends ConnectionFields {
  id: string;
  provider: string;
  defaultModel?: string;
  expiresAt?: number | string | null;
  tokenExpiresAt?: number | string | null;
  providerSpecificData?: Record<string, unknown> | null;
}

type NoAuthProviderDefinition = {
  id?: string;
  alias?: string;
  noAuth?: boolean;
  serviceKinds?: string[];
};

type StrictEvidenceMetadata = Pick<
  ZeroSpendEvidence,
  "promotional" | "expiresAt" | "kind" | "source"
>;

export interface VirtualAutoComboCandidate {
  provider: string;
  /** A concrete connection for synthetic/no-auth candidates; null for a logical provider/model candidate. */
  connectionId: string | null;
  /** Credentialed accounts that are eligible to serve this provider/model pair. */
  allowedConnectionIds?: string[];
  model: string;
  modelStr: string; // e.g., 'openai/gpt-4o'
  costPer1MTokens: number; // from providerRegistry
  /** Strict-only verified economic metadata used for bounded promotion urgency. */
  zeroSpendEvidence?: StrictEvidenceMetadata;
  /** Build-local capability snapshot. Runtime calls rebuild it; catalog entries reuse it. */
  resolvedContextLength?: number | null;
  resolvedMaxOutputTokens?: number | null;
  resolvedSupportsVision?: boolean;
  resolvedReasoning?: boolean;
  resolvedSupportsThinking?: boolean;
}

type VirtualAutoCombo = AutoComboConfig & {
  strategy: "auto";
  models: Array<{
    id: string;
    kind: "model";
    model: string;
    providerId: string;
    connectionId: string | null;
    allowedConnectionIds?: string[];
    weight: number;
    label: string;
  }>;
  /** MAX of candidates' context windows — safe to advertise because the
   * auto-combo context pre-filter routes oversized requests to large-window
   * candidates. null when the pool is empty. */
  advertisedContextLength: number | null;
  advertisedMaxOutputTokens: number | null;
  autoConfig: {
    candidatePool: string[];
    weights: ScoringWeights;
    explorationRate: number;
    routerStrategy: string;
  };
  config: {
    auto: {
      candidatePool: string[];
      weights: ScoringWeights;
      explorationRate: number;
      routerStrategy: string;
    };
    chaos?: {
      enabled: true;
      panelSize: number;
      judgeModel?: string;
      tuning: ChaosTuning;
    };
  };
};

/**
 * Build-local candidate snapshots shared by the built-in entries in one model-catalog build.
 * Runtime routing does not retain or reuse this object across requests.
 */
export interface PreparedVirtualAutoComboInputs {
  readonly regularCandidates: readonly VirtualAutoComboCandidate[];
  readonly familyCandidates: readonly VirtualAutoComboCandidate[];
  readonly strictZeroCost: boolean;
}

function toExpiryMs(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
  }

  if (typeof value === "string") {
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  return null;
}

function hasUsableOAuthToken(conn: VirtualFactoryConn): boolean {
  if (typeof conn.accessToken !== "string" || conn.accessToken.trim().length === 0) return false;

  const expiryMs = toExpiryMs(conn.tokenExpiresAt) ?? toExpiryMs(conn.expiresAt);

  return expiryMs === null || expiryMs > Date.now();
}

function hasProviderSpecificSessionData(conn: VirtualFactoryConn): boolean {
  return hasUsableWebSessionCredential(conn.provider, conn.providerSpecificData);
}

function hasUsableConnectionCredential(conn: VirtualFactoryConn): boolean {
  const hasApiKey = typeof conn.apiKey === "string" && conn.apiKey.trim().length > 0;
  return hasApiKey || hasUsableOAuthToken(conn) || hasProviderSpecificSessionData(conn);
}

const SYNTHETIC_NOAUTH_CONNECTION_ID = RESILIENCE_NOAUTH_CONNECTION_ID;

// Allowlist of no-auth (keyless) providers permitted to enter the `auto`/`auto-*`
// candidate pool. Narrowed to the backends verified to answer without any
// configuration on our reference egress (VPS .15): `opencode` and `felo-web`
// both return 200 there, while duckduckgo-web (429/VQD rate limit), theoldllm
// (403 Vercel egress block), chipotle (502), aihorde (401, anon key rejected)
// and the others are unreliable. The excluded providers stay fully usable via
// direct `<alias>/<model>` calls — they are just kept OUT of auto-routing until
// re-verified. Re-add an id here to bring it back into every auto/* pool.
//
// Scope (operator decision 2026-07-24, refs #8183/#6453/#7032): this allowlist
// targets public-HTTP-egress reliability for the category/tier and flat-variant
// `auto/*` pools (auto/best-free, auto/coding:fast, ...). It does NOT apply to
// `auto/<family>` pools (auto/glm, auto/zai, ...) — a family combo is an
// identity selector ("whatever genuinely serves GLM"), not a reliability-curated
// pool, so it admits any no-auth backend that genuinely serves the family (e.g.
// auggie, a local CLI subprocess with zero HTTP egress, belongs in auto/glm
// regardless of this list). See the `bypassAllowlist` param below.
const AUTO_COMBO_NOAUTH_ALLOWLIST = new Set<string>(["opencode", "felo-web"]);

function isChatAutoComboNoAuthProvider(
  providerDef: NoAuthProviderDefinition,
  bypassAllowlist: boolean
): boolean {
  if (providerDef.noAuth !== true) return false;
  if (!bypassAllowlist && !AUTO_COMBO_NOAUTH_ALLOWLIST.has(providerDef.id)) return false;
  if (!Array.isArray(providerDef.serviceKinds) || providerDef.serviceKinds.length === 0)
    return true;
  return providerDef.serviceKinds.includes("llm");
}

function getNoAuthCandidates(
  excludedProviders: Set<string>,
  blockedProviders: Set<string>,
  disabledNoAuthProviders: Set<string>,
  noAuthProviderSpecificData: Map<string, Record<string, unknown> | null | undefined>,
  hiddenModelsMap: Map<string, Set<string>>,
  bypassAllowlist: boolean
): VirtualAutoComboCandidate[] {
  const registry = getProviderRegistry();
  const candidates: VirtualAutoComboCandidate[] = [];

  for (const providerDef of Object.values(NOAUTH_PROVIDERS) as NoAuthProviderDefinition[]) {
    if (!isChatAutoComboNoAuthProvider(providerDef, bypassAllowlist)) continue;

    const providerId = providerDef.id;
    if (!providerId || excludedProviders.has(providerId)) continue;
    if (
      blockedProviders.has(providerId) ||
      (typeof providerDef.alias === "string" && blockedProviders.has(providerDef.alias))
    )
      continue;
    if (
      disabledNoAuthProviders.has(providerId) ||
      (typeof providerDef.alias === "string" && disabledNoAuthProviders.has(providerDef.alias))
    )
      continue;

    const providerInfo = registry[providerId];
    const registryModels = Array.isArray(providerInfo?.models) ? providerInfo.models : [];
    if (registryModels.length === 0) continue;

    const registryAlias =
      typeof providerInfo?.alias === "string" && providerInfo.alias.trim().length > 0
        ? providerInfo.alias
        : null;
    const routingPrefix = providerDef.alias || registryAlias || providerId;

    const providerSpecificData =
      noAuthProviderSpecificData.get(providerId) ??
      (typeof providerDef.alias === "string"
        ? noAuthProviderSpecificData.get(providerDef.alias)
        : undefined);

    const hiddenModels =
      hiddenModelsMap.get(providerId) ??
      (typeof providerDef.alias === "string" ? hiddenModelsMap.get(providerDef.alias) : undefined);

    for (const model of registryModels) {
      const modelId = typeof model?.id === "string" && model.id.trim().length > 0 ? model.id : null;
      if (!modelId) continue;
      if (isModelExcludedByConnection(modelId, providerSpecificData)) continue;
      if (hiddenModels?.has(modelId)) continue;
      candidates.push({
        provider: providerId,
        connectionId: SYNTHETIC_NOAUTH_CONNECTION_ID,
        model: modelId,
        modelStr: `${routingPrefix}/${modelId}`,
        costPer1MTokens: 0,
      });
    }
  }

  return candidates;
}

const DEFAULT_ADVERTISED_MAX_OUTPUT_TOKENS = 8192;

type AdvertisedLimitCandidate = {
  provider: string;
  model: string;
  resolvedContextLength?: number | null;
  resolvedMaxOutputTokens?: number | null;
};

export function computeAdvertisedLimits(candidates: AdvertisedLimitCandidate[]): {
  contextLength: number | null;
  maxOutputTokens: number | null;
} {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { contextLength: null, maxOutputTokens: null };
  }

  let contextLength: number | null = null;
  let maxOutputTokens: number | null = null;
  for (const candidate of candidates) {
    const limit =
      candidate.resolvedContextLength !== undefined
        ? candidate.resolvedContextLength
        : getTokenLimit(candidate.provider, candidate.model);
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      contextLength = contextLength === null ? limit : Math.max(contextLength, limit);
    }
    const output =
      candidate.resolvedMaxOutputTokens !== undefined
        ? candidate.resolvedMaxOutputTokens
        : getResolvedModelCapabilities({
            provider: candidate.provider,
            model: candidate.model,
          }).maxOutputTokens;
    if (typeof output === "number" && Number.isFinite(output) && output > 0) {
      maxOutputTokens = maxOutputTokens === null ? output : Math.max(maxOutputTokens, output);
    }
  }
  if (maxOutputTokens === null) {
    maxOutputTokens = DEFAULT_ADVERTISED_MAX_OUTPUT_TOKENS;
  }
  return { contextLength, maxOutputTokens };
}

const PREPARED_CAPABILITY_YIELD_INTERVAL = 16;

type PreparedCapabilityValues = {
  resolvedContextLength: number | null;
  resolvedMaxOutputTokens: number | null;
  resolvedSupportsVision: boolean;
  resolvedReasoning: boolean;
  resolvedSupportsThinking: boolean;
};

type PreparedCapabilityState = {
  byTarget: Map<string, Map<string, PreparedCapabilityValues>>;
  resolvedSinceYield: number;
  resolutionSnapshot: ModelCapabilityResolutionSnapshot;
};

function yieldVirtualAutoPreparationTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function attachPreparedCapabilityValues(
  candidates: readonly VirtualAutoComboCandidate[],
  state: PreparedCapabilityState
): Promise<VirtualAutoComboCandidate[]> {
  const prepared: VirtualAutoComboCandidate[] = [];
  for (const candidate of candidates) {
    let byModel = state.byTarget.get(candidate.provider);
    if (!byModel) {
      byModel = new Map();
      state.byTarget.set(candidate.provider, byModel);
    }
    let values = byModel.get(candidate.model);
    if (!values) {
      const contextLength = getTokenLimit(
        candidate.provider,
        candidate.model,
        state.resolutionSnapshot
      );
      const capabilities = getResolvedModelCapabilities(
        {
          provider: candidate.provider,
          model: candidate.model,
        },
        undefined,
        state.resolutionSnapshot
      );
      const maxOutputTokens = capabilities.maxOutputTokens;
      values = {
        resolvedContextLength:
          Number.isFinite(contextLength) && contextLength > 0 ? contextLength : null,
        resolvedMaxOutputTokens:
          typeof maxOutputTokens === "number" &&
          Number.isFinite(maxOutputTokens) &&
          maxOutputTokens > 0
            ? maxOutputTokens
            : null,
        resolvedSupportsVision: capabilities.supportsVision === true,
        resolvedReasoning: capabilities.reasoning === true,
        resolvedSupportsThinking: capabilities.supportsThinking === true,
      };
      byModel.set(candidate.model, values);
      state.resolvedSinceYield++;
      if (state.resolvedSinceYield >= PREPARED_CAPABILITY_YIELD_INTERVAL) {
        state.resolvedSinceYield = 0;
        await yieldVirtualAutoPreparationTurn();
      }
    }
    prepared.push({ ...candidate, ...values });
  }
  return prepared;
}

function attachStrictEvidenceMetadata(
  candidates: VirtualAutoComboCandidate[]
): VirtualAutoComboCandidate[] {
  return candidates.map((candidate) => {
    const ids = candidate.connectionId
      ? [candidate.connectionId]
      : candidate.allowedConnectionIds ?? [];
    for (const connectionId of ids) {
      if (connectionId === SYNTHETIC_NOAUTH_CONNECTION_ID) continue;
      const evidence = peekZeroSpendEvidence(candidate.provider, connectionId, candidate.model);
      if (evidence?.status !== "SAFE") continue;
      return {
        ...candidate,
        zeroSpendEvidence: {
          promotional: evidence.promotional,
          expiresAt: evidence.expiresAt,
          kind: evidence.kind,
          source: evidence.source,
        },
      };
    }
    return candidate;
  });
}

export async function prepareVirtualAutoComboInputs(
  options: { includeResolvedCapabilities?: boolean } = {}
): Promise<PreparedVirtualAutoComboInputs> {
  const [connections, disabledNoAuthConnections, settings] = await Promise.all([
    getCachedProviderConnections({ isActive: true }) as Promise<VirtualFactoryConn[]>,
    getCachedProviderConnections({ isActive: false }) as Promise<VirtualFactoryConn[]>,
    getSettings().catch(() => ({}) as Record<string, unknown>),
  ]);
  const strictZeroCost = settings.freeAccessPolicy === "strict";
  const blockedProviders = new Set(
    Array.isArray(settings.blockedProviders) ? (settings.blockedProviders as string[]) : []
  );
  const disabledNoAuthProviders = new Set(
    disabledNoAuthConnections
      .filter((conn) => conn.provider in NOAUTH_PROVIDERS)
      .map((conn) => conn.provider)
  );
  const hiddenModelsMap = getHiddenModelsByProvider();
  const noAuthProviderSpecificData = new Map<string, Record<string, unknown> | null | undefined>();
  for (const conn of [...connections, ...disabledNoAuthConnections]) {
    if (conn.provider in NOAUTH_PROVIDERS) {
      noAuthProviderSpecificData.set(conn.provider, conn.providerSpecificData);
    }
  }

  const validConnections = connections.filter(hasUsableConnectionCredential);

  const candidatePool: VirtualAutoComboCandidate[] = [];
  const registry = getProviderRegistry();
  const connectionsByProvider = new Map<string, VirtualFactoryConn[]>();
  for (const conn of validConnections) {
    const providerConnections = connectionsByProvider.get(conn.provider) ?? [];
    providerConnections.push(conn);
    connectionsByProvider.set(conn.provider, providerConnections);
  }

  for (const [providerId, providerConnections] of connectionsByProvider) {
    const providerInfo = registry[providerId];
    const registryModelIds = Array.isArray(providerInfo?.models)
      ? providerInfo.models
          .map((model) => (typeof model?.id === "string" ? model.id.trim() : ""))
          .filter(Boolean)
      : [];
    const registryModelIdSet = new Set(registryModelIds);
    const defaultModelIds = providerConnections
      .map((conn) => (typeof conn.defaultModel === "string" ? conn.defaultModel.trim() : ""))
      .filter(Boolean);
    const hiddenModels = hiddenModelsMap.get(providerId);

    const [syncedByConnection, customModels] = await Promise.all([
      getSyncedAvailableModelsByConnection(providerId),
      getCustomModels(providerId),
    ]);
    const userVisibleIds = new Set<string>();
    for (const models of Object.values(syncedByConnection)) {
      for (const m of models) if (m.id && !hiddenModels?.has(m.id)) userVisibleIds.add(m.id);
    }
    for (const m of customModels) if (m.id && !hiddenModels?.has(m.id)) userVisibleIds.add(m.id);
    const hasUserModels = userVisibleIds.size > 0;
    const modelIds = hasUserModels
      ? Array.from(userVisibleIds)
      : Array.from(new Set([...registryModelIds, ...defaultModelIds]));

    for (const modelId of modelIds) {
      if (hiddenModels?.has(modelId)) continue;

      const allowedConnectionIds = providerConnections
        .filter((conn) => {
          if (isModelExcludedByConnection(modelId, conn.providerSpecificData)) return false;
          if (hasUserModels) {
            const connSynced = syncedByConnection[conn.id] ?? [];
            const isSyncedForConn = connSynced.some((m) => m.id === modelId);
            const isCustomForProvider = customModels.some((m) => m.id === modelId);
            return isSyncedForConn || isCustomForProvider || conn.defaultModel?.trim() === modelId;
          }
          return registryModelIdSet.has(modelId) || conn.defaultModel?.trim() === modelId;
        })
        .map((conn) => conn.id);
      if (allowedConnectionIds.length === 0) continue;

      candidatePool.push({
        provider: providerId,
        connectionId: null,
        allowedConnectionIds,
        model: modelId,
        modelStr: `${providerId}/${modelId}`,
        costPer1MTokens: 0,
      });
    }
  }

  const connectionsById = new Map<string, ConnectionResilienceView>();
  for (const conn of [...connections, ...disabledNoAuthConnections]) {
    connectionsById.set(conn.id, conn);
  }

  const connectedProviders = new Set(validConnections.map((conn) => conn.provider));
  const buildPreparedPool = (bypassNoAuthAllowlist: boolean) => {
    let pool = [
      ...candidatePool,
      ...getNoAuthCandidates(
        connectedProviders,
        blockedProviders,
        disabledNoAuthProviders,
        noAuthProviderSpecificData,
        hiddenModelsMap,
        bypassNoAuthAllowlist
      ),
    ];

    const resilienceFilteredPool = filterResilienceBlockedCandidates(pool, connectionsById);
    if (resilienceFilteredPool !== pool) pool = resilienceFilteredPool;

    const paidFilteredPool = filterPaidOnlyCandidates(pool, settings.hidePaidModels === true);
    if (paidFilteredPool !== pool) pool = paidFilteredPool;

    if (strictZeroCost) {
      const strictFilteredPool = filterStrictZeroCostCandidates(pool, {
        enabled: true,
        resolveZeroSpendEvidence,
        minRemainingAllowance: 1,
        maxEvidenceAgeMs:
          (typeof settings.autoRefreshProviderQuotaInterval === "number"
            ? settings.autoRefreshProviderQuotaInterval
            : 180) * 1000,
      });
      pool = attachStrictEvidenceMetadata(strictFilteredPool);
    }

    const tosFilteredPool = filterTosAvoidCandidates(pool, settings.excludeTosAvoid === true);
    if (tosFilteredPool !== pool) pool = tosFilteredPool;
    return pool;
  };

  const regularCandidates = buildPreparedPool(false);
  const familyCandidates = buildPreparedPool(true);
  if (!options.includeResolvedCapabilities) {
    return { regularCandidates, familyCandidates, strictZeroCost };
  }

  const capabilityState: PreparedCapabilityState = {
    byTarget: new Map(),
    resolvedSinceYield: 0,
    resolutionSnapshot: createModelCapabilityResolutionSnapshot(),
  };
  return {
    regularCandidates: await attachPreparedCapabilityValues(regularCandidates, capabilityState),
    familyCandidates: await attachPreparedCapabilityValues(familyCandidates, capabilityState),
    strictZeroCost,
  };
}

export function computeSnapshotWeights(
  candidates: readonly VirtualAutoComboCandidate[],
  weights: ScoringWeights
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const c of candidates) {
    let score = 0;

    if (weights.taskFit > 0) {
      if (c.resolvedReasoning || c.resolvedSupportsThinking) score += weights.taskFit * 0.6;
      if (c.resolvedSupportsVision) score += weights.taskFit * 0.3;
    }

    if (weights.stability > 0) {
      const capabilityCount =
        Number(c.resolvedReasoning ?? false) +
        Number(c.resolvedSupportsThinking ?? false) +
        Number(c.resolvedSupportsVision ?? false);
      score += weights.stability * Math.min(capabilityCount / 2, 1);
    }

    let tierInfo: { tier: string } | null = null;
    if (weights.tierPriority > 0 || weights.costInv > 0) {
      try {
        tierInfo = classifyTier(c.provider, c.model);
      } catch {
        // fall through with zero
      }
    }
    if (tierInfo && weights.tierPriority > 0 && tierInfo.tier === "premium")
      score += weights.tierPriority;
    if (tierInfo && weights.costInv > 0 && tierInfo.tier === "free") score += weights.costInv;

    if (weights.latencyInv > 0) score += weights.latencyInv * 0.5;
    score += (weights.health + weights.quota) * 0.5;

    if (c.zeroSpendEvidence) {
      score *= promotionUrgencyMultiplier({
        promotional: c.zeroSpendEvidence.promotional,
        expiresAt: c.zeroSpendEvidence.expiresAt,
        nowMs: Date.now(),
      });
    }

    scores.set(c.modelStr, Math.min(score, 1));
  }
  return scores;
}

function clonePreparedCandidates(
  candidates: readonly VirtualAutoComboCandidate[]
): VirtualAutoComboCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    ...(candidate.allowedConnectionIds
      ? { allowedConnectionIds: [...candidate.allowedConnectionIds] }
      : {}),
    ...(candidate.zeroSpendEvidence
      ? { zeroSpendEvidence: { ...candidate.zeroSpendEvidence } }
      : {}),
  }));
}

export async function createVirtualAutoComboFromPrepared(
  prepared: PreparedVirtualAutoComboInputs,
  variant: AutoVariant | undefined,
  spec?: AutoComboSpec,
  apiKeyId?: string,
  autoChannel?: string
): Promise<VirtualAutoCombo> {
  let candidatePool = clonePreparedCandidates(
    spec?.family ? prepared.familyCandidates : prepared.regularCandidates
  );

  let excludedConnectionIds: Set<string> = new Set();
  if (apiKeyId && autoChannel) {
    try {
      excludedConnectionIds = await getExcludedConnectionIds(apiKeyId, autoChannel);
    } catch (err) {
      log.warn("AUTO", "Failed to load auto-candidate overrides; routing unfiltered", { err });
    }
  }
  const overrideFilteredPool = filterExcludedCandidates(candidatePool, excludedConnectionIds);
  if (overrideFilteredPool !== candidatePool) {
    candidatePool.length = 0;
    candidatePool.push(...overrideFilteredPool);
  }

  if (candidatePool.length === 0) {
    log.warn(
      "AUTO",
      prepared.strictZeroCost
        ? "STRICT_ZERO_COST: no verified zero-spend candidates; returning empty auto-combo"
        : "No connected providers with valid credentials for virtual auto-combo"
    );
    const emptyPool: string[] = [];
    const emptyWeights = prepared.strictZeroCost
      ? { ...MODE_PACKS["quality-first"] }
      : { ...DEFAULT_WEIGHTS };
    const autoConfig = {
      candidatePool: emptyPool,
      weights: emptyWeights,
      explorationRate: 0.05,
      routerStrategy: "lkgp",
    };
    return {
      id: `virtual-auto-${variant || "default"}`,
      name: `Auto ${variant || "Default"}`,
      type: "auto" as const,
      strategy: "auto",
      models: [],
      candidatePool: emptyPool,
      weights: autoConfig.weights,
      explorationRate: autoConfig.explorationRate,
      routerStrategy: autoConfig.routerStrategy,
      autoConfig,
      config: { auto: autoConfig },
      advertisedContextLength: null,
      advertisedMaxOutputTokens: null,
    };
  }

  let effectivePool = candidatePool;
  const strictFreeTier = prepared.strictZeroCost && spec?.tier === "free";
  const candidateFilter = spec?.family
    ? buildFamilyCandidateFilter(spec.family)
    : spec
      ? buildAutoCandidateFilter(spec.category, strictFreeTier ? undefined : spec.tier)
      : null;
  if (candidateFilter) {
    const narrowed = candidatePool.filter((candidate) => candidateFilter(candidate));
    const label = spec?.family
      ? `auto/${spec.family}`
      : `auto/${spec?.category ?? ""}${spec?.tier ? `:${spec.tier}` : ""}`;
    if (narrowed.length > 0) {
      effectivePool = narrowed;
    } else if (
      !prepared.strictZeroCost &&
      !spec?.family &&
      (process.env.OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL === "true" ||
        process.env.OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL === "1")
    ) {
      log.warn(
        "AUTO",
        `${label} matched no connected models; falling back to the full pool (OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL=true)`
      );
    } else {
      warnEmptyAutoPoolOnce(
        label,
        prepared.strictZeroCost
          ? `${label} matched no verified zero-spend models; returning an empty pool.`
          : `${label} matched no connected models; returning an empty pool.${spec?.family ? "" : ' Set OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL=true to restore the legacy "use full pool" behavior.'}`
      );
      effectivePool = [];
    }
  }

  let weights: ScoringWeights = { ...DEFAULT_WEIGHTS };
  let explorationRate = 0.05;
  let routerStrategy = "lkgp";

  switch (variant) {
    case "coding":
      weights = { ...MODE_PACKS["quality-first"] };
      break;
    case "fast":
      weights = { ...MODE_PACKS["ship-fast"] };
      break;
    case "cheap":
      weights = { ...MODE_PACKS["cost-saver"] };
      break;
    case "offline":
      weights = { ...MODE_PACKS["offline-friendly"] };
      break;
    case "smart":
      weights = { ...MODE_PACKS["quality-first"] };
      explorationRate = 0.1;
      break;
    case "lkgp":
      break;
    case "chaos":
      weights = { ...MODE_PACKS["chaos-mode"] };
      explorationRate = 0;
      break;
    case undefined:
      break;
  }

  if (spec) {
    if (spec.category && spec.category !== "chat") {
      weights = { ...MODE_PACKS["quality-first"] };
    }
    const weightVariant = tierToWeightVariant(spec.tier);
    if (weightVariant === "fast") {
      weights = { ...MODE_PACKS["ship-fast"] };
    } else if (weightVariant === "cheap") {
      weights = { ...MODE_PACKS["cost-saver"] };
    } else if (weightVariant === "reliability") {
      weights = { ...MODE_PACKS["reliability-first"] };
    }
  }

  // Once Strict has proven every surviving candidate is zero-spend-safe, nominal
  // price no longer carries useful information. Prefer the existing quality-first
  // pack and let promotion urgency act only as a bounded tiebreak-like multiplier.
  if (prepared.strictZeroCost) {
    weights = { ...MODE_PACKS["quality-first"] };
  }

  const providerPool = [...new Set(effectivePool.map((c) => c.provider))];
  const snapshotScores = computeSnapshotWeights(effectivePool, weights);
  const models = effectivePool.map((candidate, index) => ({
    id: `virtual-auto-${variant || "default"}-${index + 1}-${candidate.provider}`,
    kind: "model" as const,
    model: candidate.modelStr,
    providerId: candidate.provider,
    connectionId: candidate.connectionId,
    ...(candidate.allowedConnectionIds
      ? { allowedConnectionIds: candidate.allowedConnectionIds }
      : {}),
    weight: snapshotScores.get(candidate.modelStr) ?? 1,
    label: candidate.provider,
  }));
  const autoConfig = {
    candidatePool: providerPool,
    weights,
    explorationRate,
    routerStrategy,
  };

  const isChaos = variant === "chaos";
  const CHAOS_MAX_PANEL = (() => {
    const env = process.env.OMNIROUTE_CHAOS_MAX_PANEL;
    const parsed = env ? parseInt(env, 10) : 5;
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10) : 5;
  })();
  let chaosModels: typeof models;
  if (isChaos) {
    const seenProviders = new Set<string>();
    const diverse: typeof models = [];
    for (const m of models) {
      if (seenProviders.has(m.providerId)) continue;
      seenProviders.add(m.providerId);
      diverse.push(m);
      if (diverse.length >= CHAOS_MAX_PANEL) break;
    }
    chaosModels = diverse.length > 0 ? diverse : models.slice(0, CHAOS_MAX_PANEL);
  } else {
    chaosModels = models;
  }

  const advertisedLimits = computeAdvertisedLimits(effectivePool);

  return {
    id: `virtual-auto-${variant || "default"}`,
    name: `Auto ${variant || "Default"}`,
    type: "auto",
    strategy: "auto",
    models: chaosModels,
    candidatePool: providerPool,
    weights,
    explorationRate,
    routerStrategy,
    autoConfig,
    config: {
      auto: autoConfig,
      ...(isChaos
        ? {
            chaos: {
              enabled: true,
              panelSize: chaosModels.length,
              judgeModel: chaosModels[0]?.model,
              tuning: {
                panelHardTimeoutMs:
                  Number(process.env.OMNIROUTE_CHAOS_PANEL_TIMEOUT_MS) || undefined,
                minPanel: Number(process.env.OMNIROUTE_CHAOS_MIN_PANEL) || undefined,
              },
            },
          }
        : {}),
    },
    advertisedContextLength: advertisedLimits.contextLength,
    advertisedMaxOutputTokens: advertisedLimits.maxOutputTokens,
  };
}

export async function createVirtualAutoCombo(
  variant: AutoVariant | undefined,
  spec?: AutoComboSpec,
  apiKeyId?: string,
  autoChannel?: string
): Promise<VirtualAutoCombo> {
  const prepared = await prepareVirtualAutoComboInputs();
  return createVirtualAutoComboFromPrepared(prepared, variant, spec, apiKeyId, autoChannel);
}
