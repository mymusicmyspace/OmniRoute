export interface PromotionUrgencyInput {
  promotional: boolean;
  expiresAt: string | null;
  nowMs: number;
}

/**
 * Promotion is urgency, never quality. Keep the modifier small enough that a
 * materially better permanent-free model still wins.
 */
export function promotionUrgencyMultiplier({
  promotional,
  expiresAt,
  nowMs,
}: PromotionUrgencyInput): number {
  if (!promotional) return 1;
  if (!expiresAt) return 1.02;

  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return 1.02;

  const hours = Math.max(0, (expiresMs - nowMs) / 3_600_000);
  if (hours <= 24) return 1.08;
  if (hours <= 72) return 1.05;
  return 1.02;
}
