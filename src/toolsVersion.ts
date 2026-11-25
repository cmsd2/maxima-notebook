/**
 * The aximar tools release this extension needs. Notebook cells need an
 * aximar-mcp whose evaluate_expression takes `cell_id` (tools 0.6.0).
 */
export const MIN_TOOLS_VERSION = "0.6.0";

/** Compare dotted version numbers; a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}

export function meetsMinimum(version: string): boolean {
  return compareVersions(version, MIN_TOOLS_VERSION) >= 0;
}
