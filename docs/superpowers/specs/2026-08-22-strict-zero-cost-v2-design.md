# STRICT ZERO COST v2 — Design Specification

Date: 2026-08-22
Target repository: `mymusicmyspace/OmniRoute`
Implementation branch: `feat/strict-zero-cost-v2`
Base: current `release/v3.8.50`
Reference implementation: `feat/strict-zero-cost`

## 1. Purpose

STRICT ZERO COST v2 is an upstream-quality routing feature for OmniRoute. Its job is to guarantee that, when enabled, an `auto/*` request can only dispatch to candidates for which OmniRoute has sufficient evidence that the request cannot create incremental monetary spend for the operator.

The feature must also make good use of temporary zero-cost opportunities. A model that is normally paid but is temporarily free, covered by promotional credit, or exposed through a temporary `:free`/`-free` route should be eligible when zero-spend safety can be proven. When that zero-cost condition disappears, the candidate must automatically leave the safe pool without requiring a code change or manual model blacklist.

After economic safety is established, routing should optimize primarily for model quality, task fit, health, latency and stability. Promotional status is an urgency signal, not a quality signal: it may improve priority among otherwise strong candidates, but it must never make a weak model outrank a substantially better free model merely because the weak model is promotional.

This feature is intentionally generic. KITT, b.ai, TokenRouter, Kimi, DeepSeek and other named services are validation examples, not hardcoded routing policy.

## 2. Goals

1. Preserve the fail-closed economic guarantee of the existing `feat/strict-zero-cost` work.
2. Port the valid v1 safety invariants and regression tests onto the current OmniRoute release base instead of maintaining an old fork tip.
3. Distinguish economic safety from quota availability and from model quality.
4. Support permanent free tiers, recurring free quotas, one-time free allowances, promotional credits, effective zero-price promotions and keyless/no-auth providers when the evidence is strong enough.
5. Allow newly discovered models to participate without adding model IDs to the Strict filter itself.
6. Remove a candidate automatically when the supporting zero-cost evidence becomes stale, exhausted, invalid or no longer applicable.
7. Preserve per-connection safety: in a provider with several accounts, only verified-safe accounts remain selectable.
8. Rank the post-safety pool for quality rather than continuing to optimize heavily for nominal price after every surviving candidate is already zero-spend safe.
9. Keep the change maintainable and reviewable upstream through small, well-bounded components and tests.
10. Keep existing routing byte-compatible when the feature is disabled.

## 3. Non-goals

This PR does not implement audio/STT auto-routing. That will be a separate PR after the core economic policy is accepted.

This PR does not modify KITT.

This PR does not scrape arbitrary websites on every request to discover promotions.

This PR does not assume that a model is safe merely because its name contains `free`, `promo`, `trial` or a similar token.

This PR does not assume that a temporary promotion implies high model quality.

This PR does not guarantee discovery of a promotion when the provider exposes no trustworthy machine-readable or curated economic evidence. In that case Strict remains fail-closed.

This PR does not mark an entire provider safe because one model on that provider is free.

## 4. Core architecture

The routing pipeline becomes conceptually:

```text
candidate discovery
      |
      v
existing resilience / hidden / blocked filters
      |
      v
STRICT ZERO COST evidence evaluation
      |
      +-- unsafe / unknown --> excluded
      |
      v
verified zero-spend pool
      |
      v
capability / family / request compatibility
      |
      v
quality-first scoring
      |
      v
small promotion-urgency adjustment
      |
      v
normal Auto-Combo dispatch + fallback
```

The important separation is:

- `ZeroSpendSafety`: Can this concrete model/account request create incremental spend?
- `Availability`: Is the free allowance or promotional capacity still usable now?
- `ModelQuality`: How strong is this model for the current task?
- `PromotionUrgency`: Is there a temporary use-it-before-you-lose-it reason to prefer this candidate among similarly good safe candidates?

These concerns must not be collapsed into one numeric score.

## 5. Safety evidence model

Introduce a typed internal evidence representation. Exact naming may follow existing repository conventions, but the semantics must remain explicit.

Suggested shape:

```ts
type ZeroSpendEvidenceKind =
  | "keyless"
  | "hard-free-tier"
  | "free-quota"
  | "promotional-credit"
  | "effective-zero-price"
  | "account-spend-cap";

interface ZeroSpendEvidence {
  status: "SAFE" | "EXHAUSTED" | "UNKNOWN";
  kind: ZeroSpendEvidenceKind;
  checkedAt: string;
  expiresAt?: string | null;
  remainingFreeAllowance?: number | null;
  effectiveInputPrice?: number | null;
  effectiveOutputPrice?: number | null;
  paidSpendPossible: boolean;
  hardStopVerified: boolean;
  source: string;
}
```

The implementation does not need to expose this exact public API, but it must preserve these distinctions internally. A generic `remainingPercentage > 0` is not sufficient proof of zero-spend safety because that percentage may describe paid balance, subscription allowance, promotional credit or a free tier.

### 5.1 Safe acceptance rules

A credentialed candidate is eligible only when the evidence is fresh and one of the following safety patterns is proven:

1. A curated free tier has an explicit provider-side hard stop and usable free allowance remains.
2. A promotional/free-credit allowance is live, usable, and exhausting it cannot roll into paid billing.
3. The exact model has an effective input/output price of zero and the account cannot incur paid spend during the evidence validity window.
4. The account has a verified spend cap of zero or equivalent provider-side protection, making a failed promotion check incapable of producing a monetary charge.

A zero price alone is insufficient when the account can silently fall through to a paid balance after the price changes.

### 5.2 Keyless/no-auth invariant

Keep the v1 invariant: the keyless shortcut is valid only for a candidate that actually came through the synthetic no-auth path. A model catalogued as keyless but reached through a real credentialed connection must not inherit the shortcut.

### 5.3 Multi-account invariant

Keep the v1 invariant: a logical provider/model candidate with several `allowedConnectionIds` must be rewritten to the exact subset whose evidence is SAFE. Dispatch must never be able to select an account that the Strict filter did not verify.

## 6. Evidence providers and discovery

Strict itself must not hardcode provider/model names. Provider-specific economic knowledge should live behind adapters or existing metadata registries.

The implementation should reuse existing OmniRoute data where it is semantically correct, including:

- `FREE_MODEL_BUDGETS`
- provider usage adapters
- synced model catalogs
- provider pricing data
- connection state
- model/provider health data

However, v2 must not blindly interpret every usage adapter as free allowance. Where an adapter cannot distinguish free allowance from paid balance, its result is insufficient for `SAFE` until a provider-specific normalizer supplies that meaning.

### 6.1 Dynamic model discovery

A model discovered from a provider's live `/models` endpoint may become eligible without modifying Strict when:

- the model is visible to the configured connection,
- there is machine-readable or curated evidence for its zero-spend state,
- its evidence applies to that exact model/account,
- and the safety rules above pass.

Names such as `-free` and `:free` are useful alias hints but never economic proof.

### 6.2 Promotion evidence

Promotions may be represented by:

- a provider pricing endpoint reporting exact model price = 0,
- a provider quota/credit endpoint that distinguishes promotional/free credit from paid funds,
- an account spend-cap endpoint,
- or curated metadata when the provider publishes a hard-stop free offer and the metadata has an explicit refresh/expiry lifecycle.

The evidence must carry freshness. Stale promotion evidence fails closed.

## 7. Cache and invalidation

The v1 in-memory cache pattern is retained conceptually because synchronous candidate building must not perform one billing API request per model on every user request.

Requirements:

- Cache key is at least `(provider, connectionId)` and may include model where provider economics are model-specific.
- TTL remains short and configurable through existing refresh settings when possible.
- Cold or stale state returns UNKNOWN immediately and schedules background refresh for a later request.
- A failed refresh deletes any stale SAFE state.
- Quota/billing/auth failures invalidate the relevant SAFE state immediately.
- 402/403/quota-exhausted/credits-exhausted classifications must remove the candidate from subsequent pool builds without waiting for TTL.
- Promotion-expiry timestamps, when known, cap the cache lifetime even if the generic quota TTL is longer.

## 8. Ranking after safety

The existing `auto/best-free` behavior should no longer spend most of its scoring budget on nominal cost once Strict has already reduced the candidate pool to zero-spend-safe models.

When `freeAccessPolicy === "strict"` and the post-filter pool is non-empty, the scoring profile should become quality-oriented. The implementation should reuse existing Auto-Combo scoring rather than create a separate router.

Preferred behavior:

- task fitness / model intelligence: high weight
- provider health: high weight
- stability: meaningful weight
- latency/speed: meaningful but secondary
- quota headroom: meaningful
- nominal cost: minimal or zero weight because every surviving candidate is already safe for incremental spend

Exact weights must be benchmarked against existing mode packs; `quality-first` is the starting point, not an unreviewed constant requirement.

## 9. Model identity and quality inheritance

OmniRoute already resolves model quality through user overrides, Arena ELO, models.dev capabilities, static fitness data and wildcard fallback. Existing `-free` alias inheritance should be preserved.

V2 should make alias normalization more general without pretending two unrelated models are identical.

Safe canonicalization rules should support provider wrappers such as:

- trailing `-free`
- trailing `:free`
- nested provider paths where the leaf model is clearly the same model identity

Canonicalization is only for quality lookup. It must never be used as proof that the alias has the same pricing or safety properties as the canonical model.

If a newly discovered model has no trustworthy quality signal, it receives the existing neutral/unknown behavior and may be explored through normal Auto-Combo exploration. It must not receive a premium quality score merely because it is new or promotional.

## 10. Promotion urgency

Promotional state is an urgency modifier, not a quality class.

Requirements:

- No absolute "promotion always wins" rule.
- Promotion urgency is applied only after a candidate is zero-spend SAFE.
- The modifier is bounded so a materially weaker model cannot leapfrog a clearly superior stable free model solely due to promotion.
- If an explicit expiry is known, urgency may increase as expiry approaches.
- If only promotional/free-credit status is known without expiry, use a small fixed bounded boost.
- Permanent free tiers receive no urgency boost.

Implementation should prefer a bounded multiplier or additive tie-break component rather than introducing a second independent ranking engine.

## 11. Failure semantics

Strict mode must fail closed.

- Missing free metadata: exclude.
- Missing economic adapter when one is required: exclude.
- Adapter response cannot distinguish free from paid allowance: UNKNOWN, exclude.
- Stale evidence: UNKNOWN, exclude and refresh asynchronously.
- Free allowance exhausted: EXHAUSTED, exclude.
- Promotion no longer zero-priced: exclude unless another independent zero-spend proof exists.
- Account may fall through to paid spend and no hard cap exists: exclude.
- All candidates excluded: return an empty auto pool / controlled no-upstream error. Never fall back to paid/full pool.

Existing legacy free-pool fallback environment options must not bypass Strict.

## 12. Backward compatibility

The feature remains opt-in.

When `freeAccessPolicy !== "strict"`:

- candidate membership is unchanged,
- scoring behavior is unchanged,
- existing free/premium filters are unchanged,
- existing provider usage endpoints are unchanged.

No migration may silently enable Strict for existing users.

## 13. Test strategy

Implementation is test-driven. Port the valuable tests from `feat/strict-zero-cost`, then add v2 coverage before production logic.

### 13.1 Safety regression tests

Must cover:

1. genuine synthetic keyless candidate passes without credential checks;
2. keyless-catalogued model behind a real connection does not bypass safety;
3. multi-account A SAFE / B UNKNOWN rewrites to A only;
4. A EXHAUSTED / B SAFE rewrites to B only;
5. all accounts UNKNOWN excludes candidate;
6. stale SAFE state excludes candidate and triggers refresh;
7. failed refresh cannot preserve stale SAFE state;
8. 402/403/quota exhaustion invalidates SAFE state;
9. zero price with paid fallback possible is not sufficient;
10. zero price plus verified zero spend-cap/hard-stop is sufficient;
11. promotional credit with hard stop passes while allowance remains;
12. promotional credit exhaustion removes candidate;
13. provider/model not known to Strict but exposed through a valid adapter is auto-discovered;
14. names containing `free` without safety evidence remain excluded;
15. empty Strict pool never reopens through the legacy full-pool fallback.

### 13.2 Ranking tests

Must cover:

1. once all candidates are Strict SAFE, quality/task fit dominates nominal cost;
2. a strong promotional model can outrank a similar strong permanent-free model;
3. a weak promotional model does not outrank a substantially stronger permanent-free model solely because it is promotional;
4. `-free` and `:free` quality aliases inherit canonical intelligence when identity is unambiguous;
5. quality canonicalization never copies economic safety;
6. unknown-quality promotional models retain neutral/exploration behavior rather than receiving an artificial top score.

### 13.3 Integration tests

At least one integration-level test must exercise the real candidate preparation plus auto scoring path, not only pure helper functions.

A critical acceptance test must prove that with Strict enabled there is no dispatch path from the candidate pool to a connection that was not zero-spend SAFE.

## 14. Provider validation fixtures

Named providers are validation examples, not policy constants.

The initial test matrix should model at least:

- a b.ai-like provider with a temporary exact-model zero-price promotion and prepaid/no-overdraft behavior;
- a TokenRouter-like aggregator exposing both normal and explicit free aliases from a live model catalog;
- a normal recurring free-tier provider with a usage adapter;
- a provider whose usage adapter only exposes generic remaining balance and therefore remains UNKNOWN until normalized;
- a keyless provider.

Tests must use local fixtures/mocks. CI must not depend on live provider accounts, secrets or current promotions.

## 15. Observability

Strict decisions should be diagnosable without leaking secrets.

Add structured diagnostics for candidate exclusion reason, for example:

- `not_in_free_evidence`
- `hard_stop_unverified`
- `usage_unknown`
- `evidence_stale`
- `free_allowance_exhausted`
- `effective_price_nonzero`
- `paid_fallback_possible`
- `promotion_expired`

Do not log API keys, access tokens, full provider account payloads or full environment variables.

A dry-run/debug surface should show why a candidate passed or failed without dispatching a billable request.

## 16. Upstream contribution structure

This work should be submitted as a focused core-routing PR. Audio/STT routing is deliberately excluded to reduce review surface and improve acceptance probability.

Recommended commit structure:

1. port v1 Strict safety primitives + tests onto current release base;
2. introduce typed zero-spend evidence normalization;
3. add dynamic promotional/effective-price evidence path;
4. add safe model identity normalization for quality lookup;
5. switch Strict post-filter scoring toward quality-first and add bounded promotion urgency;
6. add integration/regression tests and documentation.

Each commit should build on the previous one and remain reviewable. Avoid unrelated refactors.

The PR description should explain the operator problem in general terms: `hidePaidModels` answers catalog classification, while Strict answers whether a concrete request can create incremental spend at dispatch time.

## 17. Acceptance criteria

The PR is ready for upstream review only when all of the following are true:

- Strict is opt-in and existing behavior is unchanged when off.
- The two v1 safety blockers remain covered by regression tests.
- A Strict candidate can only dispatch through a verified-safe connection.
- A temporary zero-cost model can become eligible without adding its model ID to the Strict core.
- The same model becomes ineligible automatically when its evidence expires, exhausts or turns non-zero-cost.
- Generic paid balance is never mistaken for free allowance.
- Price-zero evidence cannot expose an account to silent paid fallback.
- Strong temporary free models are favored through normal quality scoring plus a bounded urgency modifier.
- Weak promotional models do not win merely because they are promotional.
- Empty Strict pools never fall back to paid/full pools.
- Focused unit and integration suites pass.
- Typecheck/lint/repository quality gates pass for the branch, apart from any separately documented pre-existing upstream baseline failures.
- No secrets, live account identifiers or provider credentials are added to the repository.

## 18. Follow-up PR: audio/STT zero-cost routing

After this core PR is accepted or stable, a second independent PR will apply the same policy to `/v1/audio/transcriptions`.

That PR will add an audio-capability-aware automatic selector rather than attempting to send `auto/best-free` through the current transcription model parser. It will reuse the core zero-spend evidence layer and restrict the pool to transcription-capable models/providers.

Keeping this separate ensures the core economic-safety feature is independently useful and upstream-reviewable.

## 19. Rollback and maintainability

Because the feature is opt-in, operational rollback is setting `freeAccessPolicy` back to `off`.

Code maintenance should favor isolated modules and reusable provider adapters over edits scattered across provider executors. If upstream later implements equivalent functionality, individual commits/components should be removable without rewriting the entire fork.

The old `feat/strict-zero-cost` branch remains a historical reference and regression source. It is not the deployment target for v2.
