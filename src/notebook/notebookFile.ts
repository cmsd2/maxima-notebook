/**
 * Maxima notebook files and VS Code's notebook model.
 *
 * The file format (docs/notebook-format.md in the aximar repository) is
 * read and written by the `aximar-notebook-format` package, the same code
 * Aximar uses. This module maps its model to VS Code's: a cell's one
 * `Output` becomes a list of VS Code outputs, each tagged with the part it
 * holds, and back.
 */

import * as vscode from "vscode";
import { newId, read, validId, write } from "aximar-notebook-format";
import type { Cell, NotebookFile, Output } from "aximar-notebook-format";
import type { EvalResult } from "./types";

export const MIME = {
  latex: "application/x-maxima-latex",
  plotly: "application/x-maxima-plotly",
  svg: "image/svg+xml",
  png: "image/png",
  plain: "text/plain",
  error: "application/vnd.code.notebook.error",
} as const;

/** The language of raw cells: kept as text, never run. */
export const RAW_LANGUAGE = "raw";

/**
 * What a VS Code cell keeps of its file cell, in the cell's metadata. The
 * file cell's own metadata goes under `metadata`, so the two can't mix.
 */
export interface CellMetadata {
  id?: string;
  metadata?: Record<string, unknown>;
  /** Fields of the file cell the format doesn't read, such as `attachments` */
  extra?: Record<string, unknown>;
  /** Outputs of kinds the extension doesn't show, written back until the cell runs */
  otherOutputs?: unknown[];
}

/** Which part of a run a VS Code output holds, in the output's metadata. */
type Part = "print" | "result" | "plot" | "error";

interface OutputMetadata {
  part?: Part;
  /** The result's one-line form, written as its `text/plain` */
  textPlain?: string | null;
  /** An SVG plot as received: the shown copy is resized to fit */
  svg?: string;
}

export function cellMetadata(cell: { metadata?: { [key: string]: unknown } }): CellMetadata {
  return (cell.metadata ?? {}) as CellMetadata;
}

/** A code cell that runs as Maxima: not a markdown or raw cell. */
export function isMaximaCode(cell: vscode.NotebookCell): boolean {
  return (
    cell.kind === vscode.NotebookCellKind.Code &&
    cell.document.languageId !== RAW_LANGUAGE
  );
}

// ── Files ──────────────────────────────────────────────────────────────

/** Read a notebook file. An empty file is a new notebook with one empty cell. */
export function notebookFromFile(text: string): vscode.NotebookData {
  if (!text.trim()) {
    return new vscode.NotebookData([
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "maxima"),
    ]);
  }
  // Throws on JSON that isn't a notebook, so VS Code shows the error rather
  // than opening an empty notebook that would overwrite the file on save
  const file = read(text);
  const data = new vscode.NotebookData(file.cells.map(cellFromFile));
  data.metadata = file.metadata ?? {};
  return data;
}

/** Write a notebook file, as Aximar writes it. */
export function notebookToFile(data: vscode.NotebookData): string {
  const used = new Set<string>();
  const file: NotebookFile = {
    metadata: data.metadata ?? {},
    cells: data.cells.map((cell) => cellToFile(cell, used)),
  };
  return write(file);
}

function cellFromFile(cell: Cell): vscode.NotebookCellData {
  const data =
    cell.cellType === "markdown"
      ? new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, cell.input, "markdown")
      : new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          cell.input,
          cell.cellType === "raw" ? RAW_LANGUAGE : "maxima",
        );
  const metadata: CellMetadata = { id: cell.id, metadata: cell.metadata ?? {} };
  if (cell.extra && Object.keys(cell.extra).length > 0) {
    metadata.extra = cell.extra;
  }
  const output = cell.output;
  if (output) {
    data.outputs = buildOutputs(output);
    if (output.otherOutputs && output.otherOutputs.length > 0) {
      metadata.otherOutputs = output.otherOutputs;
    }
    if (output.executionCount != null) {
      data.executionSummary = { executionOrder: output.executionCount };
    }
  }
  data.metadata = metadata as { [key: string]: unknown };
  return data;
}

function cellToFile(cell: vscode.NotebookCellData, used: Set<string>): Cell {
  const metadata = cellMetadata(cell);
  // New and pasted cells get their IDs as they're added (cellIds.ts); this
  // covers a cell saved before that edit lands
  let id = metadata.id;
  if (!id || !validId(id) || used.has(id)) {
    id = newId();
  }
  used.add(id);

  const base = { id, input: cell.value, metadata: metadata.metadata ?? {}, extra: metadata.extra ?? {} };
  if (cell.kind === vscode.NotebookCellKind.Markup) {
    return { ...base, cellType: "markdown" };
  }
  if (cell.languageId === RAW_LANGUAGE) {
    return { ...base, cellType: "raw" };
  }
  return {
    ...base,
    cellType: "code",
    output: outputFromCell(
      cell.outputs ?? [],
      cell.executionSummary?.executionOrder ?? null,
      metadata.otherOutputs ?? [],
    ),
  };
}

// ── Outputs ────────────────────────────────────────────────────────────

/** A run's result from aximar-mcp, in the format's terms. */
export function outputFromResult(result: EvalResult): Output {
  return {
    textOutput: result.text_output ?? "",
    latex: result.latex ?? null,
    textPlain: result.text_plain ?? null,
    plotSvg: result.plot_svg ?? null,
    plotData: result.plot_data ?? null,
    imagePng: result.image_png ?? null,
    error: result.error ?? null,
    isError: result.is_error,
    executionCount: result.execution_count ?? null,
  };
}

/**
 * VS Code outputs for a cell's output, in the order the file keeps them:
 * print text, the result, plots, then the error.
 */
export function buildOutputs(output: Output): vscode.NotebookCellOutput[] {
  const outputs: vscode.NotebookCellOutput[] = [];
  const tagged = (items: vscode.NotebookCellOutputItem[], metadata: OutputMetadata) =>
    outputs.push(new vscode.NotebookCellOutput(items, metadata as { [key: string]: unknown }));
  const text = (value: string, mime: string) => vscode.NotebookCellOutputItem.text(value, mime);

  // With no separate message, an error is in the print text: show it once
  const printIsError = Boolean(output.isError) && output.error == null;
  if (output.textOutput && !printIsError) {
    tagged([text(output.textOutput, MIME.plain)], { part: "print" });
  }
  if (output.latex != null) {
    tagged([text(output.latex, MIME.latex)], { part: "result", textPlain: output.textPlain ?? null });
  } else if (output.textPlain != null) {
    tagged([text(output.textPlain, MIME.plain)], { part: "result", textPlain: output.textPlain });
  }
  if (output.plotData != null) {
    tagged([text(output.plotData, MIME.plotly), text("<Plotly figure>", MIME.plain)], { part: "plot" });
  }
  if (output.plotSvg != null) {
    tagged([text(shrinkSvg(output.plotSvg), MIME.svg)], { part: "plot", svg: output.plotSvg });
  }
  if (output.imagePng != null) {
    tagged(
      [new vscode.NotebookCellOutputItem(Buffer.from(output.imagePng, "base64"), MIME.png)],
      { part: "plot" },
    );
  }
  if (output.isError) {
    const message = output.error ?? output.textOutput?.trim() ?? "";
    tagged([vscode.NotebookCellOutputItem.error(errorWithoutStack(message || "Evaluation error"))], {
      part: "error",
    });
  }
  return outputs;
}

/** A cell's VS Code outputs as the format's one output, or null if it has none. */
export function outputFromCell(
  outputs: readonly vscode.NotebookCellOutput[],
  executionCount: number | null,
  otherOutputs: unknown[] = [],
): Output | null {
  const out: Output = { textOutput: "", isError: false, executionCount, otherOutputs: [...otherOutputs] };
  const decode = (data: Uint8Array) => new TextDecoder().decode(data);
  for (const output of outputs) {
    const meta = (output.metadata ?? {}) as OutputMetadata;
    const item = (mime: string) => output.items.find((i) => i.mime === mime);
    const error = item(MIME.error);
    const latex = item(MIME.latex);
    const plotly = item(MIME.plotly);
    const svg = item(MIME.svg);
    const png = item(MIME.png);
    const plain = item(MIME.plain);
    if (error) {
      out.isError = true;
      out.error = errorMessage(decode(error.data));
    } else if (latex) {
      out.latex = decode(latex.data);
      out.textPlain = meta.textPlain ?? null;
    } else if (plotly) {
      out.plotData = decode(plotly.data);
    } else if (svg) {
      out.plotSvg = meta.svg ?? decode(svg.data);
    } else if (png) {
      out.imagePng = Buffer.from(png.data).toString("base64");
    } else if (plain && meta.part === "result") {
      out.textPlain = decode(plain.data);
    } else if (plain) {
      out.textOutput += decode(plain.data);
    } else if (output.items.length > 0) {
      // Another extension's output: keep it, as display_data
      out.otherOutputs!.push({
        output_type: "display_data",
        data: Object.fromEntries(output.items.map((i) => [i.mime, decode(i.data)])),
        metadata: {},
      });
    }
  }
  // A run that showed nothing (`a: 1$`) still keeps its number
  const empty = outputs.length === 0 && out.otherOutputs!.length === 0 && executionCount == null;
  return empty ? null : out;
}

function errorMessage(json: string): string {
  try {
    const err = JSON.parse(json) as { message?: string; name?: string };
    return err.message || err.name || "";
  } catch {
    return "";
  }
}

/** An Error whose stack, which VS Code shows under the message, is empty. */
export function errorWithoutStack(message: string): Error {
  const err = new Error(message);
  err.stack = "";
  return err;
}

/**
 * Make an SVG responsive by replacing fixed width/height with a max-width
 * style.  gnuplot emits e.g. `<svg width="600" height="480" ...>` which
 * causes VS Code to allocate that exact space even when `set size` shrinks
 * the plot inside the canvas.  By removing the fixed dimensions and relying
 * on the viewBox, the SVG scales to fit its container without wasted space.
 */
function shrinkSvg(svg: string): string {
  return svg.replace(
    /(<svg\b[^>]*?)\s+width="(\d+)"\s+height="(\d+)"/,
    (_match, prefix, w, h) => {
      // Ensure a viewBox exists so the aspect ratio is preserved
      const hasViewBox = /viewBox\s*=/.test(prefix);
      const viewBox = hasViewBox ? "" : ` viewBox="0 0 ${w} ${h}"`;
      return `${prefix}${viewBox} style="max-width:${w}px"`;
    },
  );
}
