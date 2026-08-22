#!/usr/bin/env node

import { getCachedProviderConnections } from "../../src/lib/db/readCache.ts";
import { getSettings } from "../../src/lib/db/settings.ts";
import {
  createZeroSpendEvidenceResolver,
} from "../../open-sse/services/autoCombo/zeroSpendEvidenceResolver.ts";
import {
  openRouterEffectivePriceSource,
  openRouterSpendSafetySource,
} from "../../open-sse/services/autoCombo/zeroSpendEvidenceBuiltins.ts";
import { evaluateZeroSpendEvidence } from "../../open-sse/services/autoCombo/zeroSpendEvidence.ts";

function usage(): never {
  console.error(
    "Usage: tsx scripts/ad-hoc/dry-run-strict-zero-cost.ts <provider> <connectionId> <model>"
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const [provider, connectionId, model] = process.argv.slice(2);
  if (!provider || !connectionId || !model) usage();

  const settings = await getSettings().catch(() => ({} as Record<string, unknown>));
  const maxAgeMs =
    (typeof settings.autoRefreshProviderQuotaInterval === "number"
      ? settings.autoRefreshProviderQuotaInterval
      : 180) * 1000;

  const resolver = createZeroSpendEvidenceResolver({
    ttlMs: maxAgeMs,
    getConnection: async (candidateProvider, candidateConnectionId) => {
      const connections = (await getCachedProviderConnections({
        provider: candidateProvider,
        isActive: true,
      })) as unknown as Record<string, unknown>[];
      return connections.find((connection) => connection.id === candidateConnectionId);
    },
  });

  // Keep this registration list aligned with production built-ins. The diagnostic
  // intentionally does not call chat/completions or any billable inference endpoint.
  resolver.registerEffectiveModelPriceSource("openrouter", openRouterEffectivePriceSource);
  resolver.registerAccountSpendSafetySource("openrouter", openRouterSpendSafetySource);

  resolver.resolve(provider, connectionId, model);
  await resolver.whenIdle();
  const evidence = resolver.peek(provider, connectionId, model);
  const evaluation = evaluateZeroSpendEvidence(evidence, {
    nowMs: Date.now(),
    maxAgeMs,
    minRemainingAllowance: 1,
  });

  console.log(
    JSON.stringify(
      {
        provider,
        model,
        connectionId,
        safe: evaluation.safe,
        reason: evaluation.reason,
        evidenceKind: evidence?.kind ?? null,
        evidenceSource: evidence?.source ?? null,
        promotional: evidence?.promotional ?? false,
        expiresAt: evidence?.expiresAt ?? null,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      safe: false,
      reason: "diagnostic_error",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exitCode = 1;
});
