# Strict Zero Cost routing

Strict Zero Cost is an opt-in Auto-Combo policy for operators who require a hard routing rule: a candidate is eligible only when OmniRoute has concrete evidence that using that provider/account/model cannot create incremental monetary spend.

It is deliberately stricter than `hidePaidModels`. `hidePaidModels` is a catalog/tier convenience filter; Strict Zero Cost is an economic safety gate evaluated per concrete connection and model.

## Enable

The core policy is persisted as `freeAccessPolicy = "strict"`. From a source checkout, use the operator helper:

```bash
npx tsx scripts/ad-hoc/configure-strict-zero-cost.ts enable
```

Check or disable it with:

```bash
npx tsx scripts/ad-hoc/configure-strict-zero-cost.ts status
npx tsx scripts/ad-hoc/configure-strict-zero-cost.ts disable
```

The default is off. A missing value or any value other than `"strict"` preserves existing Auto-Combo candidate membership and scoring. Dashboard/API exposure of this low-level policy can be added independently without changing the routing contract.

## What Strict proves

Strict evaluates a concrete `(provider, connectionId, model)` tuple. Evidence is typed as one of:

- `keyless` — a curated, genuinely no-auth route;
- `hard-free-tier` — a provider-documented free tier with a verified hard stop;
- `free-quota` — live free allowance with verified no-paid-fallback semantics;
- `promotional-credit` — temporary free allowance that expires or can be exhausted;
- `effective-zero-price` — a live effective model price of exactly zero combined with independent spend-safety evidence;
- `account-spend-cap` — an account-side hard cap proving paid spend cannot occur.

A model name containing `free`, `promo`, `trial`, `-free`, or `:free` is never economic proof by itself.

## Fail-closed behavior

Strict rejects a candidate when evidence is missing, stale, ambiguous, exhausted, expired, nonzero-priced, or permits paid fallback without a verified hard stop.

A cold cache therefore returns `UNKNOWN`, schedules a bounded background refresh, and excludes the candidate until fresh evidence exists. Strict never reuses stale `SAFE` evidence optimistically.

Evidence cache entries are keyed by provider, connection, and model. Invalidation uses generation guards, so a refresh that started before an invalidation cannot repopulate stale `SAFE` evidence afterwards.

## Synthetic no-auth routes

A genuine synthetic no-auth route has no user billing account. Such a route can be admitted from exact curated free-catalog membership, provided the entry is not discontinued. Free-looking names alone are insufficient.

This shortcut is limited to the synthetic no-auth connection identity. A credentialed account using the same provider/model still requires concrete typed evidence.

## Multi-account safety

A logical Auto-Combo candidate may represent several accounts through `allowedConnectionIds`. Strict evaluates each account independently and rewrites the candidate to the exact verified-safe subset.

If account A is `SAFE` and account B is `UNKNOWN`, the model remains eligible only through account A. If every account is unsafe or unknown, the candidate is removed. This prevents downstream account fallback from silently selecting an unverified account.

## Dynamic promotions and provider adapters

Promotional model IDs are not hard-coded in the central policy. Provider adapters can publish independently reviewable economic facts such as current effective price, remaining free allowance, and account-side spend protection. The resolver can compose those facts into typed evidence.

For `effective-zero-price`, both input and output price must be exactly zero and a separate account-safety fact must prove that paid fallback cannot silently create spend. Provider adapter failures or ambiguous billing semantics produce no permission to route.

The core PR intentionally does not declare a live provider-specific promotion safe merely because a public catalog currently shows `$0`. Providers without sufficiently strong spend-safety evidence remain `UNKNOWN` and are excluded. New provider adapters can be added separately when their billing and hard-stop semantics are documented and testable.

## Ranking after the safety gate

Once Strict has reduced the pool to verified zero-spend candidates, nominal price is no longer useful for choosing among them. Auto-Combo uses the existing `quality-first` scoring pack in Strict mode.

Temporary promotions receive only a bounded urgency multiplier: permanent-free candidates receive `1.00`; promotional evidence receives a small boost; a promotion close to expiry can receive up to `1.08`.

Promotion is an urgency signal, not a quality signal. A materially stronger permanent-free model must still beat a weak promotional model.

Quality lookup aliases such as `model-free` and `model:free` may inherit benchmark intelligence from their canonical model ID. Alias normalization is lookup-only and never feeds back into economic evidence.

## `auto/best-free`

When Strict is enabled, `auto/best-free` means "best model among the currently verified zero-spend pool". Static free-tier classification cannot discard a dynamically verified zero-spend candidate merely because its normal tier is not free.

If Strict produces an empty pool, the virtual combo remains empty. `OMNIROUTE_AUTO_FREE_FALLBACK_TO_FULL_POOL=true` cannot reopen a paid/full pool while Strict is active.

## Provider adapter rules

A provider evidence adapter must follow these invariants:

1. Do not infer free allowance from a generic balance or percentage whose billing semantics are unknown.
2. Do not infer economic safety from the model name.
3. Treat stale or failed provider lookups as absence of proof.
4. Model effective price and spend protection separately whenever paid fallback is possible.
5. Include expiry when the provider exposes one; expired evidence is unusable.
6. Invalidate cached evidence immediately when billing/quota state proves old evidence may no longer be valid.
7. Never embed API keys, account identifiers, or operator-specific promotional model IDs in core routing policy.

## Scope

Strict Zero Cost currently applies to LLM Auto-Combo routing. Audio/STT automatic routing is intentionally separate and can adopt the same evidence architecture in a follow-up change.
