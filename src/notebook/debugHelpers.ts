/**
 * Helper functions for notebook debugging: notebook type checks,
 * temp file generation, and diagnostic logging.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { NOTEBOOK_TYPE, NOTEBOOK_TYPE_COMPAT } from "./controller";
import type { CellLineMapping } from "./sourceMapping";

// ── Constants ────────────────────────────────────────────────────────

const MAXIMA_NOTEBOOK_TYPES = [NOTEBOOK_TYPE, NOTEBOOK_TYPE_COMPAT];
const TEMP_FILE_PREFIX = "__maxima_notebook_debug_";
const TEMP_FILE_EXT = ".mac";

export const NOTEBOOK_DEBUG_NAMES = ["Debug Notebook", "Debug From Cell"];

// ── Logging ──────────────────────────────────────────────────────────

/** Lazily created output channel for notebook debug tracker diagnostics. */
let debugTrackerOutput: vscode.OutputChannel | undefined;

export function trackerLog(msg: string): void {
  if (!debugTrackerOutput) {
    debugTrackerOutput = vscode.window.createOutputChannel("Maxima Notebook Debug Tracker");
  }
  debugTrackerOutput.appendLine(msg);
}

// ── Helpers ──────────────────────────────────────────────────────────

export function isMaximaNotebook(notebook: vscode.NotebookDocument): boolean {
  return MAXIMA_NOTEBOOK_TYPES.includes(notebook.notebookType);
}

function getTempFileName(notebook: vscode.NotebookDocument): string {
  let baseName: string;
  if (notebook.isUntitled) {
    baseName = "untitled";
  } else {
    baseName = path
      .basename(notebook.uri.fsPath)
      .replace(/[^a-zA-Z0-9]/g, "_");
  }
  return `${TEMP_FILE_PREFIX}${baseName}${TEMP_FILE_EXT}`;
}

// ── Temp file generation ─────────────────────────────────────────────

export async function generateTempFile(
  notebook: vscode.NotebookDocument,
  upToCellIndex?: number,
): Promise<{ tempFilePath: string; mappings: CellLineMapping[] }> {
  const lastIndex = upToCellIndex ?? notebook.cellCount - 1;
  const codeCells: {
    cellIndex: number;
    cellUri: string;
    source: string;
  }[] = [];

  for (let i = 0; i <= lastIndex && i < notebook.cellCount; i++) {
    const cell = notebook.cellAt(i);
    if (cell.kind === vscode.NotebookCellKind.Code) {
      codeCells.push({
        cellIndex: i,
        cellUri: cell.document.uri.toString(),
        source: cell.document.getText(),
      });
    }
  }

  if (codeCells.length === 0) {
    throw new Error("No code cells found in the notebook.");
  }

  const notebookName = notebook.isUntitled
    ? "Untitled"
    : path.basename(notebook.uri.fsPath);

  const lines: string[] = [];
  lines.push("/* === Maxima Notebook Debug === */");
  lines.push(`/* Generated from: ${notebookName} */`);
  lines.push("");

  const mappings: CellLineMapping[] = [];

  for (const { cellIndex, cellUri, source } of codeCells) {
    const commentLine = lines.length + 1;
    lines.push(`/* Cell ${cellIndex + 1} (line ${commentLine}) */`);

    const startLine = lines.length + 1;
    const sourceLines = source.split("\n");
    if (
      sourceLines.length > 1 &&
      sourceLines[sourceLines.length - 1] === ""
    ) {
      sourceLines.pop();
    }
    for (const line of sourceLines) {
      lines.push(line);
    }
    lines.push("");

    mappings.push({
      cellIndex,
      cellUri,
      startLine,
      lineCount: sourceLines.length,
    });
  }

  const tempFilePath = path.join(os.tmpdir(), getTempFileName(notebook));
  await fs.writeFile(tempFilePath, lines.join("\n"), "utf-8");

  return { tempFilePath, mappings };
}
