function pushUnique(out: string[], value: string): void {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 0 && !out.includes(normalized)) out.push(normalized);
}

/**
 * Produce conservative lookup-only aliases for quality/intelligence metadata.
 *
 * This function MUST NOT be used for pricing, quota, or zero-spend evidence:
 * economic identity always remains the concrete provider/account/model tuple.
 */
export function qualityAliasCandidates(modelId: string): string[] {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return [];

  const out: string[] = [];
  pushUnique(out, normalized);

  const withoutFreeTag = normalized.endsWith(":free")
    ? normalized.slice(0, -":free".length)
    : normalized.endsWith("-free")
      ? normalized.slice(0, -"-free".length)
      : normalized;
  pushUnique(out, withoutFreeTag);

  // Nested gateway ids often carry provider/vendor prefixes around the canonical
  // model id. The final path component is safe as a *quality lookup candidate*
  // because a match still has to exist in intelligence metadata; it never changes
  // the concrete route or its economic evidence.
  const lastSlash = withoutFreeTag.lastIndexOf("/");
  if (lastSlash >= 0 && lastSlash < withoutFreeTag.length - 1) {
    pushUnique(out, withoutFreeTag.slice(lastSlash + 1));
  }

  return out;
}
