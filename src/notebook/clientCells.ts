/**
 * Client cells: aximar-mcp numbers each run and resolves `%oN` and `%`
 * against the cells the extension names. The extension sends a cell's
 * source unchanged with its ID and the IDs of the code cells above it.
 */

/** The parts of an MCP tool listing the check reads. */
export interface ListedTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

/**
 * Whether this aximar-mcp runs expressions as client cells. Older servers
 * (tools-v0.5.0 and before) drop an unknown `cell_id` silently, so the
 * extension reads the schema instead of trusting the call to fail.
 */
export function supportsClientCells(tools: readonly ListedTool[]): boolean {
  const evaluate = tools.find((t) => t.name === "evaluate_expression");
  const properties = evaluate?.inputSchema?.properties ?? {};
  return "cell_id" in properties && "cells_above" in properties;
}

/** A notebook cell as the ID list needs it. */
export interface CellRef {
  id: string;
  isCode: boolean;
}

/** The IDs of the code cells above `index`, top first. */
export function cellsAbove(cells: readonly CellRef[], index: number): string[] {
  return cells
    .slice(0, index)
    .filter((c) => c.isCode)
    .map((c) => c.id);
}
