/**
 * The extension's notebook files, against the shared test notebooks in
 * fixtures/ (see its README). Reading a file into VS Code's model and
 * writing it again must give what Aximar's own reader and writer give.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { read, write } from "aximar-notebook-format";
import * as vscode from "vscode";
import {
  buildOutputs,
  cellMetadata,
  notebookFromFile,
  notebookToFile,
  outputFromCell,
  outputFromResult,
} from "../src/notebook/notebookFile";
import { cellIdEdits } from "../src/notebook/cellIds";

const FIXTURES = path.join(__dirname, "fixtures");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const fixtures = fs.readdirSync(FIXTURES).filter((f) => /\.(macnb|ipynb)$/.test(f));

type Json = { cells: Record<string, unknown>[]; [key: string]: unknown };

/** A VS Code round trip: read into VS Code's model, then write. */
const roundTrip = (text: string): Json => JSON.parse(notebookToFile(notebookFromFile(text)));

/** IDs a reader makes are random; number them so two reads compare equal. */
function withIdsByPosition(json: Json): Json {
  return { ...json, cells: json.cells.map((c, i) => ({ ...c, id: `cell${i}` })) };
}

describe("the shared test notebooks", () => {
  it.each(fixtures)("%s is written as Aximar writes it", (name) => {
    const text = fixture(name);
    const aximar = JSON.parse(write(read(text)));
    expect(withIdsByPosition(roundTrip(text))).toEqual(withIdsByPosition(aximar));
  });

  it("the spec example comes back byte for byte", () => {
    const text = fixture("spec-example.macnb");
    expect(notebookToFile(notebookFromFile(text))).toBe(text);
  });

  it("an old extension file's SVG reads as a plot, not its source", () => {
    const data = notebookFromFile(fixture("vscode-extension-before-s1.macnb"));
    const items = data.cells.flatMap((c) => c.outputs ?? []).flatMap((o) => o.items);
    const plain = items
      .filter((i) => i.mime === "text/plain")
      .map((i) => new TextDecoder().decode(i.data));
    expect(items.some((i) => i.mime === "image/svg+xml")).toBe(true);
    expect(plain.some((t) => t.includes("<svg"))).toBe(false);
    expect(items.some((i) => i.mime === "application/vnd.code.notebook.error")).toBe(true);

    // Written back, the plot's text/plain is a description
    const written = roundTrip(fixture("vscode-extension-before-s1.macnb"));
    const bundles = written.cells.flatMap((c) => (c.outputs as Record<string, any>[]) ?? []);
    const svg = bundles.find((o) => o.data?.["image/svg+xml"]);
    expect(svg).toMatchObject({ output_type: "display_data", data: { "text/plain": ["<SVG plot>"] } });
    // ...and every cell has an ID now
    expect(written.cells.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(true);
  });

  it("keeps a Jupyter file's raw cell and its metadata", () => {
    const text = fixture("jupyter-4.0.ipynb");
    const data = notebookFromFile(text);
    const raw = data.cells.find((c) => c.languageId === "raw");
    expect(raw?.kind).toBe(vscode.NotebookCellKind.Code);
    const written = roundTrip(text);
    expect(written.cells.some((c) => c.cell_type === "raw")).toBe(true);
    expect(written.metadata).toMatchObject(JSON.parse(text).metadata);
  });

  it("keeps the valid, unique cell IDs a file has", () => {
    const ids = notebookFromFile(fixture("cell-ids.macnb")).cells.map((c) => cellMetadata(c).id);
    expect(ids).toContain("a1");
    expect(ids).toContain("b-2_c");
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("runs", () => {
  /** A one-cell notebook holding a run's result, written and parsed. */
  function saved(result: Parameters<typeof outputFromResult>[0]): Record<string, any> {
    const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "x;", "maxima");
    cell.metadata = { id: "c" };
    cell.outputs = buildOutputs(outputFromResult(result));
    cell.executionSummary = { executionOrder: result.execution_count ?? undefined };
    return JSON.parse(notebookToFile(new vscode.NotebookData([cell]))).cells[0];
  }

  it("writes a result's one-line form as its text/plain", () => {
    const cell = saved({ is_error: false, text_output: "hi", latex: "{{x^2}\\over{2}}", text_plain: "x^2/2", execution_count: 3 });
    expect(cell.execution_count).toBe(3);
    expect(cell.outputs).toEqual([
      { output_type: "stream", name: "stdout", text: ["hi"] },
      {
        output_type: "execute_result",
        execution_count: 3,
        data: { "text/latex": ["{{x^2}\\over{2}}"], "text/plain": ["x^2/2"] },
        metadata: {},
      },
    ]);
  });

  it("writes no text/plain when the server didn't send one", () => {
    const cell = saved({ is_error: false, latex: "x", execution_count: 1 });
    expect(cell.outputs[0].data).toEqual({ "text/latex": ["x"] });
  });

  it("writes an error once, as an error output", () => {
    const cell = saved({ is_error: true, text_output: "", error: "before\nexpt: undefined", execution_count: 2 });
    expect(cell.outputs).toEqual([
      { output_type: "error", ename: "MaximaError", evalue: "before\nexpt: undefined", traceback: [] },
    ]);
  });

  it("keeps the number of a run that showed nothing", () => {
    const cell = saved({ is_error: false, text_output: "", execution_count: 4 });
    expect(cell.execution_count).toBe(4);
    expect(cell.outputs).toEqual([]);
  });

  it("saves the plot as received, not the copy resized for display", () => {
    const svg = '<svg width="600" height="480" xmlns="http://www.w3.org/2000/svg"></svg>';
    const outputs = buildOutputs(outputFromResult({ is_error: false, plot_svg: svg }));
    const shown = new TextDecoder().decode(outputs[0].items[0].data);
    expect(shown).not.toBe(svg);
    expect(outputFromCell(outputs, null)?.plotSvg).toBe(svg);
  });
});

describe("cell IDs for added cells", () => {
  const cell = (index: number, id?: string) =>
    ({ index, metadata: id ? { id } : {} }) as unknown as vscode.NotebookCell;

  it("gives a new cell an ID and a pasted copy its own", () => {
    const kept = cell(0, "a1");
    const fresh = cell(1);
    const pasted = cell(2, "a1");
    const edits = cellIdEdits([kept, fresh, pasted], new Set([fresh, pasted])) as unknown as {
      index: number;
      newCellMetadata: { id: string };
    }[];
    expect(edits.map((e) => e.index)).toEqual([1, 2]);
    const ids = edits.map((e) => e.newCellMetadata.id);
    expect(ids.every((id) => id && id !== "a1")).toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it("leaves an added cell whose ID is free, as after an undo", () => {
    const restored = cell(1, "b2");
    expect(cellIdEdits([cell(0, "a1"), restored], new Set([restored]))).toEqual([]);
  });
});

describe("files that aren't notebooks", () => {
  it("opens an empty file as a notebook with one empty cell", () => {
    const data = notebookFromFile("");
    expect(data.cells).toHaveLength(1);
    expect(data.cells[0].value).toBe("");
  });

  it("refuses JSON that isn't a notebook, rather than opening it empty", () => {
    expect(() => notebookFromFile("{oops")).toThrow();
    expect(() => notebookFromFile('{"nbformat": 3, "cells": []}')).toThrow();
  });
});
