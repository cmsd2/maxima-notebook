import { describe, expect, it } from "vitest";
import { cellsAbove, supportsClientCells } from "../src/notebook/clientCells";
import { compareVersions, meetsMinimum } from "../src/toolsVersion";

const evaluate = (properties: Record<string, unknown>) => ({
  name: "evaluate_expression",
  inputSchema: { properties },
});

describe("supportsClientCells", () => {
  it("accepts a server whose evaluate_expression takes cell_id and cells_above", () => {
    const tools = [
      { name: "search_functions" },
      evaluate({ expression: {}, session_id: {}, cell_id: {}, cells_above: {} }),
    ];
    expect(supportsClientCells(tools)).toBe(true);
  });

  it("refuses tools-v0.5.0's schema, which drops cell_id silently", () => {
    expect(supportsClientCells([evaluate({ expression: {}, session_id: {} })])).toBe(false);
  });

  it("refuses a server without evaluate_expression or a schema", () => {
    expect(supportsClientCells([])).toBe(false);
    expect(supportsClientCells([{ name: "evaluate_expression" }])).toBe(false);
  });
});

describe("cellsAbove", () => {
  const cells = [
    { id: "md", isCode: false },
    { id: "a", isCode: true },
    { id: "b", isCode: true },
    { id: "md2", isCode: false },
    { id: "c", isCode: true },
  ];

  it("lists the code cells above, top first", () => {
    expect(cellsAbove(cells, 4)).toEqual(["a", "b"]);
  });

  it("lists nothing for the first cell", () => {
    expect(cellsAbove(cells, 0)).toEqual([]);
  });
});

describe("tools versions", () => {
  it("compares by number, not as text", () => {
    expect(compareVersions("0.10.0", "0.6.0")).toBeGreaterThan(0);
    expect(compareVersions("0.6", "0.6.0")).toBe(0);
    expect(compareVersions("0.5.0", "0.6.0")).toBeLessThan(0);
  });

  it("needs 0.6.0 for notebook cells", () => {
    expect(meetsMinimum("0.5.0")).toBe(false);
    expect(meetsMinimum("0.6.0")).toBe(true);
    expect(meetsMinimum("1.0.0")).toBe(true);
  });
});
