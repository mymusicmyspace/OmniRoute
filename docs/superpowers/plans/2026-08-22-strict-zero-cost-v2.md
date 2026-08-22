# STRICT ZERO COST v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an opt-in OmniRoute routing policy that can prove a concrete candidate cannot create incremental monetary spend, dynamically admit safe temporary zero-cost opportunities, and rank the surviving pool primarily by quality rather than nominal price.

**Architecture:** Keep candidate discovery and normal Auto-Combo dispatch unchanged, but insert a typed zero-spend evidence layer between the existing paid-model/resilience filters and scoring. Evidence is normalized per concrete provider/account/model, cached with fail-closed freshness rules, and used to rewrite multi-account allowlists to only verified-safe connections. Once Strict has reduced the pool to zero-spend-safe candidates, reuse Auto-Combo's existing quality-first machinery plus a small bounded promotion-urgency modifier.

**Tech Stack:** TypeScript, Node.js, OmniRoute Auto-Combo, SQLite-backed provider/model metadata, existing usage/pricing adapters, Node test runner, tsx, ESLint, markdownlint.

**Spec:** `docs/superpowers/specs/2026-08-22-strict-zero-cost-v2-design.md`

## Global Constraints

- Base implementation work on `release/v3.8.50` through branch `feat/strict-zero-cost-v2`; do not build on the old `feat/strict-zero-cost` tip.
- `freeAccessPolicy !== "strict"` must preserve existing candidate membership, scoring, provider usage behavior, and free/premium filters.
- Strict mode is fail-closed: UNKNOWN, stale, exhausted, ambiguous, or paid-fallback-capable evidence excludes the candidate.
- A `free`, `promo`, `trial`, `-free`, or `:free` name is never economic proof by itself.
- Keyless bypass is valid only for the genuine synthetic no-auth candidate path.
- Multi-account candidates must be rewritten to the exact verified-safe `allowedConnectionIds` subset.
- Empty Strict pools must never reopen through `OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL` or another full-pool fallback.
- Generic paid balance must never be interpreted as free allowance.
- Promotion is an urgency signal, not a quality signal; weak promo models must not outrank materially stronger free models solely because of promotion.
- No KITT-specific logic, API keys, tokens, live account identifiers, or provider credentials may enter this PR.
- Audio/STT auto-routing is excluded from this implementation plan and remains a follow-up PR.
- Follow TDD: each behavior change starts with a failing test, then minimal implementation, then focused verification.

---

## File Structure

### New core units

- `open-sse/services/autoCombo/zeroSpendEvidence.ts` — typed evidence model, freshness/safety predicates, exclusion reasons, promotion metadata, and pure candidate/account evaluation.
- `open-sse/services/autoCombo/zeroSpendEvidenceResolver.ts` — provider/account/model evidence orchestration; combines curated free metadata, normalized usage evidence, effective pricing, and provider-side spend-safety facts without placing DB/network work in the pure filter.
- `open-sse/services/autoCombo/zeroSpendEvidenceCache.ts` — short-lived cache, model-aware cache keys, refresh scheduling, expiry capping, invalidation, and stale-SAFE removal.
- `open-sse/services/autoCombo/strictZeroCostFilter.ts` — thin pool filter built on `zeroSpendEvidence.ts`; preserves v1 identity and multi-account invariants.
- `open-sse/services/autoCombo/modelQualityAlias.ts` — conservative quality-only canonicalization for `-free`, `:free`, and unambiguous nested aliases.
- `open-sse/services/autoCombo/promotionUrgency.ts` — bounded promotion urgency calculation that cannot override large quality gaps.

### Existing units modified

- `open-sse/services/autoCombo/virtualFactory.ts` — insert Strict filtering into prepared pools, carry safe evidence metadata needed by later scoring, ensure empty Strict pools remain empty, and select strict quality-oriented scoring.
- `open-sse/services/autoCombo/taskFitness.ts` — delegate quality lookup aliases to `modelQualityAlias.ts` while preserving current resolution order.
- `open-sse/services/autoCombo/scoring.ts` and/or `open-sse/services/combo/autoStrategy.ts` — apply bounded promotion urgency after normal score calculation without changing non-Strict scoring.
- `open-sse/services/usage.ts` — only if a provider usage result needs an explicit semantic normalizer hook; do not reinterpret generic quota shapes globally.
- `open-sse/config/freeModelCatalog.ts` / generated catalog metadata — extend metadata only where needed to express hard-stop/free allowance semantics; do not add promotional model IDs as core routing policy.
- `docs/routing/STRICT_ZERO_COST.md` — operational semantics, evidence model, failure behavior, examples, diagnostics, and settings.
- `scripts/ad-hoc/dry-run-strict-zero-cost.ts` — no-dispatch diagnostics showing pass/fail reasons and evidence provenance.
- `CHANGELOG.md` — user-visible feature entry.

### Tests

- `tests/unit/autoCombo/strict-zero-cost-filter.test.ts`
- `tests/unit/autoCombo/strict-zero-cost-connection-safety.test.ts`
- `tests/unit/autoCombo/strict-zero-cost-evidence.test.ts`
- `tests/unit/autoCombo/strict-zero-cost-cache.test.ts`
- `tests/unit/autoCombo/strict-zero-cost-autodiscovery.test.ts`
- `tests/unit/autoCombo/strict-zero-cost-ranking.test.ts`
- `tests/unit/autoCombo/strict-zero-cost-integration.test.ts`
- extend `tests/unit/autoCombo/free-alias-intelligence-8601.test.ts` for `:free` and nested aliases if that remains the repository's canonical alias regression suite.

---

### Task 1: Port the v1 safety invariants onto the current release base

**Files:**
- Create: `open-sse/services/autoCombo/strictZeroCostFilter.ts`
- Create: `tests/unit/autoCombo/strict-zero-cost-filter.test.ts`
- Create: `tests/unit/autoCombo/strict-zero-cost-connection-safety.test.ts`
- Create: `tests/unit/autoCombo/strict-zero-cost-autodiscovery.test.ts`

**Interfaces:**
- Consumes: `FreeModelBudget` from `open-sse/config/freeModelCatalog.ts`; `SYNTHETIC_NOAUTH_CONNECTION_ID` from `resilienceCandidateFilter.ts`.
- Produces initially: `StrictZeroCostCandidate`, `StrictZeroCostOptions`, `filterStrictZeroCostCandidates()`, `evaluateCandidateConnections()`, `filterTosAvoidCandidates()`.
- This task deliberately uses a minimal v1-compatible `FreeAccessState`; Task 2 replaces the state source with typed v2 `ZeroSpendEvidence` while preserving these regression tests.

- [ ] **Step 1: Copy the v1 regression tests first, adapting only imports/test-runner conventions required by `release/v3.8.50`**

Use the cases already proven on `feat/strict-zero-cost`: genuine no-auth keyless pass, credentialed keyless fail, SAFE/UNKNOWN multi-account narrowing, EXHAUSTED/SAFE narrowing, all-UNKNOWN exclusion, identity preservation when unchanged, and catalog auto-discovery/removal.

Representative assertion that must exist before implementation:

```ts
const candidate = {
  provider: "fixture",
  model: "model-a",
  connectionId: null,
  allowedConnectionIds: ["A", "B"],
};
const out = filterStrictZeroCostCandidates([candidate], {
  enabled: true,
  resolveFreeAccessState: (_provider, id) =>
    id === "A"
      ? { status: "SAFE", remainingFreeAllowance: 40, resetAt: null, checkedAt: NOW }
      : undefined,
  minRemainingAllowance: 1,
  maxStateAgeMs: 180_000,
  catalog: [quotaEntry({ hardStopGuaranteed: true })],
  now: () => Date.parse(NOW),
});
assert.deepEqual(out[0].allowedConnectionIds, ["A"]);
```

- [ ] **Step 2: Run the focused tests and confirm they fail because Strict is absent on the current release base**

Run:

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test \
  tests/unit/autoCombo/strict-zero-cost-filter.test.ts \
  tests/unit/autoCombo/strict-zero-cost-connection-safety.test.ts \
  tests/unit/autoCombo/strict-zero-cost-autodiscovery.test.ts
```

Expected: FAIL on missing `strictZeroCostFilter.ts` or missing exported symbols.

- [ ] **Step 3: Port the minimal pure v1 filter without DB/network dependencies**

Implement the current v1 contract closely enough to make the regression suite meaningful:

```ts
export interface StrictZeroCostCandidate {
  provider: string;
  model: string;
  connectionId: string | null;
  allowedConnectionIds?: string[];
}

export function filterStrictZeroCostCandidates<T extends StrictZeroCostCandidate>(
  pool: T[],
  options: StrictZeroCostOptions
): T[] {
  if (!options.enabled) return pool;
  // find metadata, evaluate every concrete account, drop unsafe candidates,
  // rewrite multi-account allowlists to the exact safe subset.
}
```

Preserve the v1 identity contract: disabled mode returns the original array; enabled mode returns the original array/object references when no candidate or allowlist changes.

- [ ] **Step 4: Run the three focused suites**

Run the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit the safety baseline**

```bash
git add open-sse/services/autoCombo/strictZeroCostFilter.ts \
  tests/unit/autoCombo/strict-zero-cost-filter.test.ts \
  tests/unit/autoCombo/strict-zero-cost-connection-safety.test.ts \
  tests/unit/autoCombo/strict-zero-cost-autodiscovery.test.ts
git commit -m "feat(auto): port strict zero-cost safety invariants"
```

---

### Task 2: Replace ambiguous quota state with typed zero-spend evidence

**Files:**
- Create: `open-sse/services/autoCombo/zeroSpendEvidence.ts`
- Create: `tests/unit/autoCombo/strict-zero-cost-evidence.test.ts`
- Modify: `open-sse/services/autoCombo/strictZeroCostFilter.ts`

**Interfaces:**
- Produces:

```ts
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

export function evaluateZeroSpendEvidence(
  evidence: ZeroSpendEvidence | undefined,
  options: { nowMs: number; maxAgeMs: number; minRemainingAllowance: number }
): { safe: boolean; reason: ZeroSpendExclusionReason | null };
```

- `strictZeroCostFilter.ts` consumes a resolver returning `ZeroSpendEvidence | undefined` per concrete `(provider, connectionId, model)` instead of assuming every positive percentage is a free allowance.

- [ ] **Step 1: Write evidence truth-table tests before implementation**

Include explicit cases:

```ts
assert.equal(
  evaluateZeroSpendEvidence(
    {
      status: "SAFE",
      kind: "effective-zero-price",
      checkedAt: NOW,
      expiresAt: null,
      remainingFreeAllowance: null,
      effectiveInputPrice: 0,
      effectiveOutputPrice: 0,
      paidSpendPossible: true,
      hardStopVerified: false,
      source: "fixture-pricing",
      promotional: true,
    },
    OPTIONS
  ).reason,
  "paid_fallback_possible"
);
```

Also assert: stale SAFE fails, expired promotion fails, exhausted allowance fails, zero price + verified hard stop passes, promotional credit + remaining allowance + hard stop passes, and UNKNOWN fails.

- [ ] **Step 2: Run the evidence test and confirm failure**

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test \
  tests/unit/autoCombo/strict-zero-cost-evidence.test.ts
```

Expected: FAIL on missing `zeroSpendEvidence.ts`.

- [ ] **Step 3: Implement the pure evidence evaluator**

Rules in code must be explicit, not inferred from generic quota percentages:

```ts
export function evaluateZeroSpendEvidence(evidence: ZeroSpendEvidence | undefined, opts: EvidenceEvalOptions) {
  if (!evidence || evidence.status === "UNKNOWN") return deny("usage_unknown");
  if (evidence.status === "EXHAUSTED") return deny("free_allowance_exhausted");
  if (isExpired(evidence.expiresAt, opts.nowMs)) return deny("promotion_expired");
  if (isStale(evidence.checkedAt, opts.nowMs, opts.maxAgeMs)) return deny("evidence_stale");
  if (evidence.paidSpendPossible && !evidence.hardStopVerified) return deny("paid_fallback_possible");
  if (evidence.kind === "effective-zero-price") {
    if (evidence.effectiveInputPrice !== 0 || evidence.effectiveOutputPrice !== 0) {
      return deny("effective_price_nonzero");
    }
  }
  if (evidence.remainingFreeAllowance !== null && evidence.remainingFreeAllowance <= opts.minRemainingAllowance) {
    return deny("free_allowance_exhausted");
  }
  return { safe: true, reason: null };
}
```

- [ ] **Step 4: Adapt `strictZeroCostFilter.ts` to evaluate evidence per concrete account/model**

Change the injected resolver signature to:

```ts
resolveZeroSpendEvidence: (
  provider: string,
  connectionId: string,
  model: string
) => ZeroSpendEvidence | undefined;
```

Keep genuine no-auth keyless as the only no-resolver shortcut. Preserve the exact-safe-subset rewrite.

- [ ] **Step 5: Run Task 1 + Task 2 suites together**

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test \
  tests/unit/autoCombo/strict-zero-cost-filter.test.ts \
  tests/unit/autoCombo/strict-zero-cost-connection-safety.test.ts \
  tests/unit/autoCombo/strict-zero-cost-autodiscovery.test.ts \
  tests/unit/autoCombo/strict-zero-cost-evidence.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit typed economic evidence**

```bash
git add open-sse/services/autoCombo/zeroSpendEvidence.ts \
  open-sse/services/autoCombo/strictZeroCostFilter.ts \
  tests/unit/autoCombo/strict-zero-cost-evidence.test.ts \
  tests/unit/autoCombo/strict-zero-cost-filter.test.ts \
  tests/unit/autoCombo/strict-zero-cost-connection-safety.test.ts
git commit -m "feat(auto): model typed zero-spend evidence"
```

---

### Task 3: Build fail-closed evidence resolution, cache, and invalidation

**Files:**
- Create: `open-sse/services/autoCombo/zeroSpendEvidenceResolver.ts`
- Create: `open-sse/services/autoCombo/zeroSpendEvidenceCache.ts`
- Create: `tests/unit/autoCombo/strict-zero-cost-cache.test.ts`
- Extend: `tests/unit/autoCombo/strict-zero-cost-evidence.test.ts`
- Modify only if semantically required: `open-sse/services/usage.ts`

**Interfaces:**
- Produces:

```ts
export interface ZeroSpendEvidenceSource {
  id: string;
  resolve(input: {
    provider: string;
    connectionId: string;
    model: string;
    connection: Record<string, unknown>;
  }): Promise<ZeroSpendEvidence | undefined>;
}

export function resolveZeroSpendEvidence(
  provider: string,
  connectionId: string,
  model: string
): ZeroSpendEvidence | undefined;

export function invalidateZeroSpendEvidence(
  provider: string,
  connectionId: string,
  model?: string
): void;
```

- Cache key must distinguish model-specific economics:

```ts
const key = `${provider}\u0000${connectionId}\u0000${model}`;
```

- [ ] **Step 1: Write cache lifecycle tests**

Required test sequence:

```ts
// cold read => undefined and exactly one refresh scheduled
// fresh SAFE read => returns evidence
// stale SAFE read => undefined and refresh scheduled
// refresh rejection => old SAFE entry deleted
// expiresAt sooner than generic TTL => entry expires at expiresAt
// invalidate(provider, connection, model) => exact entry removed
// invalidate(provider, connection) => all model entries for that account removed
```

Use injected `now()` and injected source functions; no live network.

- [ ] **Step 2: Run cache tests and verify failure**

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test \
  tests/unit/autoCombo/strict-zero-cost-cache.test.ts
```

Expected: FAIL on missing cache/resolver modules.

- [ ] **Step 3: Implement cache with cold/stale fail-closed reads and background refresh**

Core behavior:

```ts
export function getCachedEvidence(key: EvidenceKey): ZeroSpendEvidence | undefined {
  const entry = cache.get(keyString(key));
  if (!entry || isExpired(entry, now())) {
    if (entry) cache.delete(keyString(key));
    scheduleRefresh(key);
    return undefined;
  }
  return entry.evidence;
}
```

Do not return a stale SAFE value while refresh runs. Deduplicate in-flight refreshes and cap concurrency using the same pattern as the v1 `freeAccessQuota.ts` implementation.

- [ ] **Step 4: Implement resolver composition without guessing semantic meaning**

Resolution order should be explicit:

1. genuine no-auth remains handled by the filter, not resolver;
2. curated free metadata can nominate a free allowance source but cannot manufacture live allowance;
3. provider-specific normalized free-allowance evidence may produce SAFE/EXHAUSTED;
4. effective zero-price evidence may produce SAFE only when account-side paid-spend protection is independently verified;
5. generic usage payload with ambiguous balance semantics yields UNKNOWN.

Do not add a catch-all conversion from arbitrary `quotas.*.remainingPercentage` to `promotional-credit` or `free-quota`.

- [ ] **Step 5: Add an adapter seam instead of editing the central dispatcher for every future provider**

Expose a small registration/lookup map in the resolver module:

```ts
const evidenceSources = new Map<string, ZeroSpendEvidenceSource[]>();

export function registerZeroSpendEvidenceSource(provider: string, source: ZeroSpendEvidenceSource) {
  const list = evidenceSources.get(provider) ?? [];
  evidenceSources.set(provider, [...list, source]);
}
```

Production registration should happen from a stable module initialization path, not from tests. Tests must reset registrations between cases.

- [ ] **Step 6: Run cache + evidence + safety suites**

Run the Task 2 command plus `strict-zero-cost-cache.test.ts`.

Expected: PASS.

- [ ] **Step 7: Commit evidence lifecycle infrastructure**

```bash
git add open-sse/services/autoCombo/zeroSpendEvidenceResolver.ts \
  open-sse/services/autoCombo/zeroSpendEvidenceCache.ts \
  tests/unit/autoCombo/strict-zero-cost-cache.test.ts \
  tests/unit/autoCombo/strict-zero-cost-evidence.test.ts
git commit -m "feat(auto): add zero-spend evidence lifecycle"
```

---

### Task 4: Add dynamic promotional/effective-price discovery without model whitelists

**Files:**
- Extend: `open-sse/services/autoCombo/zeroSpendEvidenceResolver.ts`
- Extend as needed: `open-sse/config/freeModelCatalog.ts`
- Modify only with documented provider semantics: provider registry metadata files under `open-sse/config/providers/registry/`
- Extend: `tests/unit/autoCombo/strict-zero-cost-autodiscovery.test.ts`
- Extend: `tests/unit/autoCombo/strict-zero-cost-evidence.test.ts`

**Interfaces:**
- Add a provider/account spend-safety fact separate from model price:

```ts
export interface AccountSpendSafety {
  paidSpendPossible: boolean;
  hardStopVerified: boolean;
  source: string;
  checkedAt: string;
}
```

- Add effective-price source result:

```ts
export interface EffectiveModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  checkedAt: string;
  expiresAt: string | null;
  source: string;
}
```

- Produces no model-ID whitelist in `strictZeroCostFilter.ts`.

- [ ] **Step 1: Write provider-neutral fixtures for the four required economic shapes**

Create tests modelling:

```ts
const baiLike = {
  price: { inputPerMillion: 0, outputPerMillion: 0 },
  spendSafety: { paidSpendPossible: false, hardStopVerified: true },
};
const tokenRouterLikeFreeAlias = {
  model: "vendor/model-x-free",
  price: { inputPerMillion: 0, outputPerMillion: 0 },
};
const ambiguousBalanceProvider = {
  usage: { quotas: { balance: { remainingPercentage: 80 } } },
};
const recurringFreeTier = {
  freeAllowance: { remaining: 60, hardStopVerified: true },
};
```

Assertions:
- b.ai-like exact-model zero price + hard stop => SAFE;
- same exact-model zero price + paid fallback possible => UNKNOWN/unsafe;
- newly discovered free alias is not SAFE from its name alone;
- ambiguous 80% balance remains UNKNOWN;
- recurring free tier with normalized allowance/hard stop => SAFE;
- removing or expiring the price evidence makes the model disappear without changing code/catalog model IDs.

- [ ] **Step 2: Run autodiscovery/evidence suites and verify the new cases fail**

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test \
  tests/unit/autoCombo/strict-zero-cost-autodiscovery.test.ts \
  tests/unit/autoCombo/strict-zero-cost-evidence.test.ts
```

Expected: FAIL on missing effective-price/account-safety composition.

- [ ] **Step 3: Implement provider-neutral composition**

The resolver may synthesize a `ZeroSpendEvidence` only when independent facts compose safely:

```ts
if (
  price?.inputPerMillion === 0 &&
  price?.outputPerMillion === 0 &&
  spendSafety?.hardStopVerified === true &&
  spendSafety.paidSpendPossible === false
) {
  return {
    status: "SAFE",
    kind: "effective-zero-price",
    checkedAt: newestSafeTimestamp(price.checkedAt, spendSafety.checkedAt),
    expiresAt: price.expiresAt,
    remainingFreeAllowance: null,
    effectiveInputPrice: 0,
    effectiveOutputPrice: 0,
    paidSpendPossible: false,
    hardStopVerified: true,
    source: `${price.source}+${spendSafety.source}`,
    promotional: price.expiresAt !== null,
  };
}
```

If only price is known, return no SAFE evidence.

- [ ] **Step 4: Add provider metadata/adapters only where documentation proves semantics**

For each provider wired in production, record source comments next to the adapter/registry metadata explaining whether it is prepaid, has a hard stop, exposes promotional/free credit distinctly, or exposes exact effective pricing. Do not infer hard-stop behavior from a successful zero-balance test alone.

If neither b.ai nor TokenRouter exposes enough machine-readable/account-safety evidence to meet the rule, leave that provider UNKNOWN in the core PR and keep the provider-neutral fixture tests; do not weaken the safety contract to make the example pass.

- [ ] **Step 5: Run autodiscovery/evidence/safety suites**

Expected: PASS.

- [ ] **Step 6: Commit dynamic economic discovery**

```bash
git add open-sse/services/autoCombo/zeroSpendEvidenceResolver.ts \
  open-sse/config/freeModelCatalog.ts \
  open-sse/config/providers/registry \
  tests/unit/autoCombo/strict-zero-cost-autodiscovery.test.ts \
  tests/unit/autoCombo/strict-zero-cost-evidence.test.ts
git commit -m "feat(auto): discover verified zero-cost promotions"
```

Only include registry/catalog paths actually changed; do not create no-op metadata edits merely to match the command template.

---

### Task 5: Make quality identity robust and add bounded promotion urgency

**Files:**
- Create: `open-sse/services/autoCombo/modelQualityAlias.ts`
- Create: `open-sse/services/autoCombo/promotionUrgency.ts`
- Modify: `open-sse/services/autoCombo/taskFitness.ts`
- Modify: `open-sse/services/autoCombo/scoring.ts` and/or `open-sse/services/combo/autoStrategy.ts`
- Create: `tests/unit/autoCombo/strict-zero-cost-ranking.test.ts`
- Extend: `tests/unit/autoCombo/free-alias-intelligence-8601.test.ts`

**Interfaces:**
- Produces:

```ts
export function qualityAliasCandidates(modelId: string): string[];

export interface PromotionUrgencyInput {
  promotional: boolean;
  expiresAt: string | null;
  nowMs: number;
}

export function promotionUrgencyMultiplier(input: PromotionUrgencyInput): number;
```

- Multiplier contract: `1.0 <= result <= 1.08`; permanent free => `1.0`. The exact cap may be reduced by tests if 8% is enough to overturn a material quality gap.
- Quality aliasing is lookup-only and must never feed back into economic evidence.

- [ ] **Step 1: Write alias tests**

Required expectations:

```ts
assert.deepEqual(qualityAliasCandidates("mimo-v2.5-free"), ["mimo-v2.5-free", "mimo-v2.5"]);
assert.deepEqual(qualityAliasCandidates("vendor/model-x:free"), ["vendor/model-x:free", "vendor/model-x", "model-x"]);
assert.deepEqual(qualityAliasCandidates("vendor/model-x-free"), ["vendor/model-x-free", "vendor/model-x", "model-x"]);
```

Do not strip arbitrary words like `promo`, `vision`, `pro`, `exp`, or version suffixes unless an existing canonical model mapping proves identity.

- [ ] **Step 2: Write ranking tests before implementation**

Use deterministic candidate scores. Required properties:

```ts
// quality 0.95 permanent vs quality 0.55 promotional => permanent wins
// quality 0.92 promotional vs quality 0.91 permanent => promo may win
// promotion with known near expiry gets >= unknown-expiry promo boost
// permanent free gets multiplier 1.0
// Strict off => existing scoring result byte/number identical
```

- [ ] **Step 3: Run ranking and alias tests and confirm failure**

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test \
  tests/unit/autoCombo/free-alias-intelligence-8601.test.ts \
  tests/unit/autoCombo/strict-zero-cost-ranking.test.ts
```

Expected: FAIL on missing alias/urgency helpers or new assertions.

- [ ] **Step 4: Implement conservative quality alias candidates**

Modify `getTaskFitnessWithSource()` to try the literal ID first, then `qualityAliasCandidates(model)` for Arena/models.dev lookup. Preserve resolution priority:

```text
user_override -> arena_elo -> models_dev_tier -> static table -> wildcard
```

A free alias must not bypass a literal user override on the alias itself.

- [ ] **Step 5: Implement bounded urgency independently from base scoring**

Example shape:

```ts
export function promotionUrgencyMultiplier({ promotional, expiresAt, nowMs }: PromotionUrgencyInput) {
  if (!promotional) return 1;
  if (!expiresAt) return 1.02;
  const hours = Math.max(0, (Date.parse(expiresAt) - nowMs) / 3_600_000);
  if (hours <= 24) return 1.08;
  if (hours <= 72) return 1.05;
  return 1.02;
}
```

Tests, not preference, decide whether the 8% ceiling is too high. Keep the function pure.

- [ ] **Step 6: Apply urgency only to Strict-safe candidates after base score calculation**

Do not add a new router. In the existing scoring path:

```ts
let score = calculateScore(factors, weights);
if (candidate.zeroSpendEvidence && strictModeEnabled) {
  score *= promotionUrgencyMultiplier({
    promotional: candidate.zeroSpendEvidence.promotional,
    expiresAt: candidate.zeroSpendEvidence.expiresAt,
    nowMs: Date.now(),
  });
}
```

Thread `strictModeEnabled`/evidence through the smallest existing candidate structure necessary; do not make global scoring assume Strict.

- [ ] **Step 7: Run ranking + existing task-fitness regression tests**

Run the Step 3 command plus `tests/unit/autoCombo/static-table-longest-match-8603.test.ts`.

Expected: PASS.

- [ ] **Step 8: Commit ranking behavior**

```bash
git add open-sse/services/autoCombo/modelQualityAlias.ts \
  open-sse/services/autoCombo/promotionUrgency.ts \
  open-sse/services/autoCombo/taskFitness.ts \
  open-sse/services/autoCombo/scoring.ts \
  open-sse/services/combo/autoStrategy.ts \
  tests/unit/autoCombo/free-alias-intelligence-8601.test.ts \
  tests/unit/autoCombo/strict-zero-cost-ranking.test.ts
git commit -m "feat(auto): rank strict zero-cost pool by quality"
```

Stage only the scoring file(s) actually modified.

---

### Task 6: Integrate Strict into virtual Auto-Combo and prove no paid/full-pool escape path

**Files:**
- Modify: `open-sse/services/autoCombo/virtualFactory.ts`
- Create: `tests/unit/autoCombo/strict-zero-cost-integration.test.ts`
- Extend: `tests/unit/autoCombo/strict-zero-cost-filter.test.ts`

**Interfaces:**
- `prepareVirtualAutoComboInputs()` consumes `settings.freeAccessPolicy === "strict"` and `resolveZeroSpendEvidence`.
- `VirtualAutoComboCandidate` gains optional internal evidence metadata sufficient for ranking, for example:

```ts
zeroSpendEvidence?: Pick<ZeroSpendEvidence, "promotional" | "expiresAt" | "kind" | "source">;
```

- `createVirtualAutoComboFromPrepared()` receives enough Strict state to select quality-oriented weights only when Strict is enabled. Prefer carrying an explicit `strictZeroCost: boolean` in `PreparedVirtualAutoComboInputs` rather than re-reading settings in multiple layers.

- [ ] **Step 1: Write an integration test around real prepared-pool creation and virtual combo creation**

The test must cover one logical multi-account model and one unsafe paid candidate. Mock DB/provider inputs using existing test helpers, then assert:

```ts
assert.deepEqual(strictPrepared.regularCandidates.map((c) => c.modelStr), ["safe/model-a"]);
assert.deepEqual(strictPrepared.regularCandidates[0].allowedConnectionIds, ["safe-account"]);

const combo = await createVirtualAutoComboFromPrepared(strictPrepared, "cheap");
assert.equal(combo.models.some((m) => m.model === "paid/model-b"), false);
assert.equal(combo.models[0].allowedConnectionIds?.includes("unsafe-account"), false);
```

The test also sets `OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL=true`, produces an empty Strict pool, and asserts `combo.models.length === 0`.

- [ ] **Step 2: Run integration test and confirm failure before wiring**

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test \
  tests/unit/autoCombo/strict-zero-cost-integration.test.ts
```

Expected: FAIL because release `virtualFactory.ts` does not invoke Strict.

- [ ] **Step 3: Wire Strict after resilience/paid filtering and before category/family narrowing**

Inside `buildPreparedPool()` preserve current filter order and insert:

```ts
const strictFilteredPool = filterStrictZeroCostCandidates(pool, {
  enabled: settings.freeAccessPolicy === "strict",
  resolveZeroSpendEvidence,
  minRemainingAllowance: 1,
  maxStateAgeMs: (settings.autoRefreshProviderQuotaInterval ?? 180) * 1000,
});
if (strictFilteredPool !== pool) pool = strictFilteredPool;
```

Attach only safe evidence metadata to surviving candidates. ToS filtering remains independent if retained from v1.

- [ ] **Step 4: Make Strict emptiness terminal before legacy free-tier fallback**

Carry an explicit boolean from preparation:

```ts
interface PreparedVirtualAutoComboInputs {
  regularCandidates: readonly VirtualAutoComboCandidate[];
  familyCandidates: readonly VirtualAutoComboCandidate[];
  strictZeroCost: boolean;
}
```

When `strictZeroCost === true`, an empty candidate pool returns an empty virtual combo immediately; the later `OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL` branch must never see a pre-Strict full pool to restore.

- [ ] **Step 5: Use quality-oriented weights once Strict has proven every candidate zero-spend safe**

For a Strict combo, start from `MODE_PACKS["quality-first"]` rather than `cost-saver` when the requested variant/tier would otherwise optimize mainly for cost. Preserve explicit category requirements (`fast`, `reliable`, family/capability constraints) and preserve all non-Strict behavior exactly.

Add an assertion to `strict-zero-cost-ranking.test.ts` that `freeAccessPolicy !== "strict"` still maps `cheap` to `cost-saver`, while Strict maps the surviving zero-spend pool to the quality-oriented profile.

- [ ] **Step 6: Run focused Strict integration plus existing Auto-Combo regression suites**

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test \
  tests/unit/autoCombo/strict-zero-cost-*.test.ts \
  tests/unit/autoCombo/paid-model-filter-6512.test.ts \
  tests/unit/autoCombo/suffixComposition-4517.test.ts \
  tests/unit/autoCombo/provider-family-combos.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Auto-Combo integration**

```bash
git add open-sse/services/autoCombo/virtualFactory.ts \
  tests/unit/autoCombo/strict-zero-cost-integration.test.ts \
  tests/unit/autoCombo/strict-zero-cost-filter.test.ts \
  tests/unit/autoCombo/strict-zero-cost-ranking.test.ts
git commit -m "feat(auto): enforce strict zero-cost before dispatch"
```

---

### Task 7: Add diagnostics, documentation, changelog, and upstream-quality verification

**Files:**
- Create or port: `scripts/ad-hoc/dry-run-strict-zero-cost.ts`
- Create/update: `docs/routing/STRICT_ZERO_COST.md`
- Modify: `CHANGELOG.md`
- Extend tests if the repository has script/docs validation for these files.

**Interfaces:**
- Dry-run output consumes the same resolver/filter used by production and returns structured rows without dispatching a model request:

```ts
interface StrictDryRunRow {
  provider: string;
  model: string;
  connectionId: string | null;
  safe: boolean;
  reason: ZeroSpendExclusionReason | null;
  evidenceKind: ZeroSpendEvidenceKind | null;
  evidenceSource: string | null;
  promotional: boolean;
  expiresAt: string | null;
}
```

- [ ] **Step 1: Implement the dry-run path using production evaluation only**

The script may read configured candidates/evidence, but it must not call chat/completions or any billable inference endpoint. It must redact credentials and never print raw provider usage payloads.

Example output fields:

```text
provider=model-gateway model=vendor/model-a safe=true kind=effective-zero-price promotional=true expiresAt=2026-08-31T00:00:00Z
provider=other model=model-b safe=false reason=paid_fallback_possible
```

- [ ] **Step 2: Write/update `docs/routing/STRICT_ZERO_COST.md`**

Document:

```text
PUT /api/settings
{ "freeAccessPolicy": "strict" }
```

Explain the difference between `hidePaidModels` and Strict, evidence kinds, fail-closed cold-cache behavior, temporary promotion lifecycle, multi-account narrowing, zero-price + hard-stop requirement, quality-first post-filter ranking, diagnostics, and why `free` in a model name is not proof.

- [ ] **Step 3: Add changelog entry**

One concise feature entry: Strict Zero Cost v2 verifies concrete account/model zero-spend evidence, supports temporary zero-cost opportunities when safely provable, and ranks verified candidates by quality.

- [ ] **Step 4: Run all focused feature tests**

```bash
DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts --test \
  tests/unit/autoCombo/strict-zero-cost-*.test.ts \
  tests/unit/autoCombo/free-alias-intelligence-8601.test.ts \
  tests/unit/autoCombo/static-table-longest-match-8603.test.ts \
  tests/unit/autoCombo/paid-model-filter-6512.test.ts \
  tests/unit/autoCombo/provider-family-combos.test.ts \
  tests/unit/autoCombo/suffixComposition-4517.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run repository quality gates scoped to changed files**

```bash
npm run test:scoped
npm run lint
npm run lint:md
npm run check:cycles
```

Expected: PASS, or any existing upstream baseline failure must be reproduced on untouched `release/v3.8.50` and documented separately before claiming the branch is green.

- [ ] **Step 6: Run type/build verification**

Use the repository-supported type/build gate available on the branch. At minimum:

```bash
npm run build:backend
```

Expected: PASS. If a cheaper documented typecheck command exists in the current release, run it before `build:backend`; do not invent a script not present in `package.json`.

- [ ] **Step 7: Review the final diff for upstream scope discipline**

Confirm with `git diff release/v3.8.50...HEAD` that the PR contains only:

```text
Strict safety/evidence
promotion/effective-price discovery
quality alias + urgency
Auto-Combo integration
focused tests
docs/changelog/dry-run
```

No KITT changes, no audio routing, no unrelated refactors, no secrets.

- [ ] **Step 8: Commit docs/diagnostics**

```bash
git add scripts/ad-hoc/dry-run-strict-zero-cost.ts docs/routing/STRICT_ZERO_COST.md CHANGELOG.md
git commit -m "docs(auto): document strict zero-cost routing"
```

- [ ] **Step 9: Prepare the upstream PR only after verification evidence exists**

PR title:

```text
feat(auto): add strict zero-cost routing with promotion-aware evidence
```

PR body must include:

```text
Problem: hidePaidModels classifies catalog models but cannot prove a concrete dispatch is still zero-spend after quotas/promotions change.

Solution: opt-in typed zero-spend evidence, per-account safe allowlists, fail-closed cache/invalidation, dynamic safe promotion admission, and quality-first ranking after safety.

Safety: unknown/stale/exhausted/paid-fallback-capable candidates are excluded; empty Strict pools never reopen to full/paid pools.

Compatibility: Strict is off by default and non-Strict routing/scoring is unchanged.

Verification: list exact focused tests, scoped test/lint/build commands, and their observed results.
```

Do not claim provider-specific live promotion support unless the production adapter is actually included and verified by non-secret tests plus documented provider semantics.
