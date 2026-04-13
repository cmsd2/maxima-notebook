/**
 * Bidirectional mapping between notebook cell URIs and a temp .mac file.
 *
 * Constructed with plain data (no VS Code dependency), so it can be
 * unit-tested without mocking the VS Code API.
 */

export interface CellLineMapping {
  cellIndex: number;
  cellUri: string;
  startLine: number; // 1-based line in temp file where cell code begins
  lineCount: number;
}

export class SourceMapping {
  readonly tempFilePath: string;
  private readonly mappings: CellLineMapping[];

  /** Maps DAP breakpoint ID → cell mapping for breakpoint-changed events. */
  private bpIdToMapping = new Map<number, CellLineMapping>();
  /** Maps DAP breakpoint ID → cell-relative line (from setBreakpoints response). */
  private bpIdToCellLine = new Map<number, number>();

  constructor(tempFilePath: string, mappings: CellLineMapping[]) {
    this.tempFilePath = tempFilePath;
    this.mappings = mappings;
  }

  // ── Lookup ────────────────────────────────────────────────────────

  /** Find the mapping entry for a given notebook cell URI. */
  mappingForCellUri(cellUri: string): CellLineMapping | undefined {
    return this.mappings.find((m) => m.cellUri === cellUri);
  }

  /**
   * Find the mapping entry that contains a given temp-file line.
   * Falls back to the nearest cell if the line is between cells
   * (e.g. on a comment or separator line).
   */
  mappingForTempLine(tempLine: number): CellLineMapping | undefined {
    if (this.mappings.length === 0) {
      return undefined;
    }
    // Exact match: line falls within a cell's range.
    for (let i = this.mappings.length - 1; i >= 0; i--) {
      const m = this.mappings[i];
      if (tempLine >= m.startLine && tempLine < m.startLine + m.lineCount) {
        return m;
      }
    }
    // Nearest: find the closest cell (handles comment/separator lines).
    let best: CellLineMapping | undefined;
    let bestDist = Infinity;
    for (const m of this.mappings) {
      const cellEnd = m.startLine + m.lineCount - 1;
      const dist = tempLine < m.startLine
        ? m.startLine - tempLine
        : tempLine - cellEnd;
      if (dist < bestDist) {
        bestDist = dist;
        best = m;
      }
    }
    return best;
  }

  /** Check whether a source path matches the temp file. */
  isTempFile(sourcePath: string): boolean {
    return sourcePath === this.tempFilePath;
  }

  // ── Coordinate translation ────────────────────────────────────────

  /** Convert a cell-relative line to a temp-file line. */
  cellToTempLine(cellUri: string, cellLine: number): number | undefined {
    const mapping = this.mappingForCellUri(cellUri);
    if (!mapping) {
      return undefined;
    }
    return cellLine - 1 + mapping.startLine;
  }

  /** Convert a temp-file line to a cell location. */
  tempToCellLocation(
    tempLine: number,
  ): { cellUri: string; cellLine: number; cellIndex: number } | undefined {
    const mapping = this.mappingForTempLine(tempLine);
    if (!mapping) {
      return undefined;
    }
    return {
      cellUri: mapping.cellUri,
      cellLine: tempLine - mapping.startLine + 1,
      cellIndex: mapping.cellIndex,
    };
  }

  /** Display name for a cell: "Cell N" (1-based). */
  cellDisplayName(cellIndex: number): string {
    return `Cell ${cellIndex + 1}`;
  }

  // ── Breakpoint ID tracking ────────────────────────────────────────

  /** Record that a DAP breakpoint ID maps to a cell and cell-relative line. */
  trackBreakpointId(
    bpId: number,
    mapping: CellLineMapping,
    cellLine: number,
  ): void {
    this.bpIdToMapping.set(bpId, mapping);
    this.bpIdToCellLine.set(bpId, cellLine);
  }

  /** Look up the cell mapping for a DAP breakpoint ID. */
  breakpointMapping(bpId: number): CellLineMapping | undefined {
    return this.bpIdToMapping.get(bpId);
  }

  /** Look up the cell-relative line for a DAP breakpoint ID. */
  breakpointCellLine(bpId: number): number | undefined {
    return this.bpIdToCellLine.get(bpId);
  }
}
