# Strict Zero Cost routing

Strict Zero Cost is an opt-in Auto-Combo policy for operators who require a hard routing rule: a candidate is eligible only when OmniRoute has concrete evidence that using that provider/account/model cannot create incremental monetary spend.

It is deliberately stricter than `hidePaidModels`. `hidePaidModels` is a catalog/tier convenience filter; Strict Zero Cost is an economic safety gate evaluated per concrete connection and model.

## Enable

Persist the setting through the normal settings API:

```http
PUT /api/settings
Content-Type: application/json

{ "freeAccessPolicy": "strict" }
```

The default is effectively off: a missing value or any value other than `"strict"` preserves the existing Auto-Combo candidate membership and scoring path.

An independent optional policy can also exclude catalog entries whose documented Terms-of-Service verdict is `avoid`:

```json
{ "excludeTosAvoid": true }
```

## What Strict proves

Strict evaluates a concrete `(provider, connectionId, model)` tuple. Evidence is typed as one of:

- `keyless` — a curated, genuinely no-auth route;
- `hard-free-tier` — a provider-documented free tier with a verified hard stop;
- `free-quota` — live free allowance with verified no-paid-fallback semantics;
- `promotional-credit` — temporary free allowance that expires or can be exhausted;
- `effective-zero-price` — a live effective model price of exactly zero, combined with an independent spend-safety fact;
- `account-spend-cap` — an account-side hard cap proving paid spend cannot occur.

A model name containing `free`, `promo`, `trial`, `-free`, or `:free` is never proof by itself.

## Fail-closed behavior

Strict rejects a candidate when evidence is missing, stale, ambiguous, exhausted, expired, nonzero-priced, or permits a paid fallback without a verified hard stop.

A cold cache therefore behaves intentionally differently from normal routing: the first lookup may return `UNKNOWN`, schedule a bounded background refresh, and exclude the candidate until fresh evidence is available. Strict never uses stale `SAFE` evidence optimistically.

Evidence cache entries are keyed by provider, connection, and model. Invalidation uses generation guards, so a response from a refresh that started before an invalidation cannot repopulate a stale `SAFE` entry afterwards.

## Multi-account safety

A logical Auto-Combo candidate may represent several accounts through `allowedConnectionIds`. Strict evaluates each account independently and rewrites the candidate to the exact verified-safe subset.

For example, if account A is `SAFE` and account B is `UNKNOWN`, the model remains eligible only through account A. If every account is unsafe or unknown, the candidate is removed.

This prevents downstream account fallback from silently selecting an unverified paid account.

## Temporary promotions and dynamic discovery

Promotional models are not maintained as a static whitelist. Provider adapters can publish two independent facts:

1. the model's current effective price; and
2. the provider/account spend-safety contract.

The resolver composes those facts into `effective-zero-price` evidence only when input and output price are both exactly zero and the spend-safety fact proves that paid fallback cannot occur.

The initial production adapter uses OpenRouter's live `/models` catalog. A fresh exact 0/0 price is eligible; stale catalog data, missing pricing fields, request/image fees, or any nonzero token price fail closed. Models already present in OmniRoute's permanent free catalog are treated as permanent free; a newly observed zero-price model is marked promotional automatically, without adding its model ID to core routing policy.

The source registry is intentionally extensible. New providers should add a provider-specific price/quota adapter plus a separately reviewable spend-safety contract rather than teaching the central resolver to guess from generic balances.

## Ranking after the safety gate

Once Strict has reduced the pool to verified zero-spend candidates, nominal price is no longer useful for choosing among them. Auto-Combo therefore uses the existing `quality-first` scoring pack in Strict mode.

Temporary promotions receive only a bounded urgency multiplier:

- permanent free: `1.00`;
- promotion with unknown/far expiry: small boost;
- promotion close to expiry: larger boost;
- absolute maximum: `1.08`.

Promotion is an urgency signal, not a quality signal. A materially stronger permanent-free model must still beat a weak promotional model.

Quality lookup aliases such as `model-free` and `model:free` may inherit benchmark intelligence from their canonical model ID. This aliasing is lookup-only and never feeds back into economic evidence.

## `auto/best-free`

When Strict is enabled, `auto/best-free` means "best model among the currently verified zero-spend pool". The old static `:free` tier classification is not allowed to discard a dynamically verified promotion simply because the model's normal tier is premium.

If Strict produces an empty pool, the virtual combo remains empty. `OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL=true` cannot reopen a paid/full pool while Strict is active.

## Diagnostics

The dry-run diagnostic reads connection metadata and evidence sources but never calls a chat/completions or other billable inference endpoint:

```bash
npx tsx scripts/ad-hoc/dry-run-strict-zero-cost.ts \
  openrouter <connection-id> <model-id>
```

Example output:

```json
{
  "provider": "openrouter",
  "model": "vendor/model-a",
  "connectionId": "…",
  "safe": true,
  "reason": null,
  "evidenceKind": "effective-zero-price",
  "evidenceSource": "openrouter-live-model-price+openrouter-exact-model-spend-safety",
  "promotional": true,
  "expiresAt": null
}
```

The diagnostic never prints API keys, tokens, credentials, or raw provider usage payloads.

## Provider adapter rules

A new provider adapter must follow these invariants:

1. Do not infer free allowance from a generic balance or percentage whose billing semantics are unknown.
2. Do not infer economic safety from the model name.
3. Treat stale or failed provider lookups as absence of proof.
4. Model effective price and spend protection separately whenever the provider can fall through to paid spend.
5. Include expiry when the provider exposes one; expired evidence is unusable.
6. Invalidate cached evidence immediately when a quota/billing failure proves the old state may no longer be valid.
7. Never embed API keys, account identifiers, or operator-specific promotional model IDs in core routing code.

## Relationship to other settings

`hidePaidModels` and Strict can be enabled together, but they solve different problems. `hidePaidModels` filters known paid catalog entries early. Strict is the final economic proof layer and remains authoritative.

`excludeTosAvoid` is independent of economic safety. A route can be zero-cost but still excluded for policy reasons.

Strict is currently scoped to LLM Auto-Combo routing. Audio/STT automatic routing is intentionally separate and can adopt the same evidence architecture in a follow-up change.
