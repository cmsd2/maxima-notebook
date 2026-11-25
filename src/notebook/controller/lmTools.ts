/**
 * VS Code Language Model Tools for Maxima notebooks.
 *
 * Bridge between AI agents (Copilot, Claude, etc.) and the notebook UI.
 * Registered via vscode.lm.registerTool() during extension activation.
 */

import * as vscode from "vscode";
import {
  NotebookController,
  NOTEBOOK_TYPE,
  NOTEBOOK_TYPE_COMPAT,
} from "./controller";
import { isMaximaCode, outputFromCell, RAW_LANGUAGE } from "../notebookFile";

// ── Input types ─────────────────────────────────────────────────────

interface RunCellInput {
  cellIndex: number;
}

interface AddCellInput {
  source: string;
  afterIndex?: number;
  kind?: "code" | "markdown";
}

// ── Helpers ─────────────────────────────────────────────────────────

const MAXIMA_NOTEBOOK_TYPES = [NOTEBOOK_TYPE, NOTEBOOK_TYPE_COMPAT];

function getActiveMaximaNotebook(): vscode.NotebookDocument | undefined {
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  if (notebook && MAXIMA_NOTEBOOK_TYPES.includes(notebook.notebookType)) {
    return notebook;
  }
  return undefined;
}

function textResult(value: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(value),
  ]);
}

const NO_NOTEBOOK_MSG =
  "No active Maxima notebook. Please open a .macnb or .ipynb file " +
  "with the Maxima kernel selected.";

/** Functions that can access the filesystem or execute shell commands. */
const DANGEROUS_FUNCTIONS = [
  "system", "load", "batchload", "batch", "save", "writefile",
  "closefile", "appendfile", "with_stdout", "stringout",
];

/** Return names of dangerous Maxima functions found in `source`. */
function detectDangerousCalls(source: string): string[] {
  const found: string[] = [];
  for (const fn of DANGEROUS_FUNCTIONS) {
    // Match function_name( allowing for whitespace
    if (new RegExp(`\\b${fn}\\s*\\(`).test(source)) {
      found.push(`${fn}()`);
    }
  }
  return found;
}

interface CellOutputInfo {
  text: string | null;
  latex: string | null;
  hasSvgPlot: boolean;
  hasPlotlyChart: boolean;
  error: string | null;
  isError: boolean;
}

function extractCellOutputs(cell: vscode.NotebookCell): CellOutputInfo {
  // The same reading a save does, so a plot's text/plain fallback isn't
  // taken for print text
  const output = outputFromCell(cell.outputs, null);
  const text = [output?.textOutput, output?.textPlain].filter(Boolean).join("\n");
  return {
    text: text || null,
    latex: output?.latex ?? null,
    hasSvgPlot: output?.plotSvg != null,
    hasPlotlyChart: output?.plotData != null,
    error: output?.error ?? null,
    isError: output?.isError ?? false,
  };
}

// ── Tool: get_cells ─────────────────────────────────────────────────

class GetCellsTool implements vscode.LanguageModelTool<object> {
  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<object>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const notebook = getActiveMaximaNotebook();
    if (!notebook) {
      return textResult(NO_NOTEBOOK_MSG);
    }

    const cells = [];
    for (let i = 0; i < notebook.cellCount; i++) {
      const cell = notebook.cellAt(i);
      const kind =
        cell.kind === vscode.NotebookCellKind.Markup
          ? "markdown"
          : cell.document.languageId === RAW_LANGUAGE
            ? "raw"
            : "code";
      const cellInfo: Record<string, unknown> = {
        index: i,
        kind,
        source: cell.document.getText(),
      };
      if (isMaximaCode(cell)) {
        cellInfo.executionCount =
          cell.executionSummary?.executionOrder ?? null;
        cellInfo.outputs = extractCellOutputs(cell);
      }
      cells.push(cellInfo);
    }

    return textResult(JSON.stringify({ cells }, null, 2));
  }

  prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<object>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return { invocationMessage: "Reading Maxima notebook cells…" };
  }
}

// ── Tool: run_cell ──────────────────────────────────────────────────

class RunCellTool implements vscode.LanguageModelTool<RunCellInput> {
  constructor(private controller: NotebookController) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RunCellInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const notebook = getActiveMaximaNotebook();
    if (!notebook) {
      return textResult(NO_NOTEBOOK_MSG);
    }

    const { cellIndex } = options.input;
    if (cellIndex < 0 || cellIndex >= notebook.cellCount) {
      return textResult(
        `Cell index ${cellIndex} is out of range. ` +
          `The notebook has ${notebook.cellCount} cells (indices 0–${notebook.cellCount - 1}).`,
      );
    }

    const cell = notebook.cellAt(cellIndex);
    if (!isMaximaCode(cell)) {
      return textResult(
        `Cell ${cellIndex} is a markdown or raw cell, not a code cell.`,
      );
    }

    try {
      await this.controller.executeCellByIndex(notebook, cellIndex);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`Execution failed: ${message}`);
    }

    const outputs = extractCellOutputs(cell);
    return textResult(
      JSON.stringify(
        {
          cellIndex,
          source: cell.document.getText(),
          executionCount: cell.executionSummary?.executionOrder ?? null,
          outputs,
        },
        null,
        2,
      ),
    );
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<RunCellInput>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    const notebook = getActiveMaximaNotebook();
    const { cellIndex } = options.input;
    const source =
      notebook && cellIndex >= 0 && cellIndex < notebook.cellCount
        ? notebook.cellAt(cellIndex).document.getText()
        : undefined;

    const dangerous = source ? detectDangerousCalls(source) : [];
    if (dangerous.length > 0) {
      const names = dangerous.join(", ");
      return {
        invocationMessage: `Running cell ${cellIndex}…`,
        confirmationMessages: {
          title: "Potentially Dangerous Code",
          message: new vscode.MarkdownString(
            `Cell ${cellIndex} uses **${names}** which can access the filesystem or run shell commands.\n\n` +
              `\`\`\`maxima\n${source}\n\`\`\`\n\nAllow execution?`,
          ),
        },
      };
    }

    return {
      invocationMessage: `Running cell ${cellIndex}…`,
      confirmationMessages: {
        title: "Run Notebook Cell",
        message: `Execute cell ${cellIndex} in the active Maxima notebook?`,
      },
    };
  }
}

// ── Tool: add_cell ──────────────────────────────────────────────────

class AddCellTool implements vscode.LanguageModelTool<AddCellInput> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<AddCellInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const notebook = getActiveMaximaNotebook();
    if (!notebook) {
      return textResult(NO_NOTEBOOK_MSG);
    }

    const { source, afterIndex } = options.input;
    let insertAt: number;
    if (afterIndex !== undefined) {
      if (afterIndex < -1 || afterIndex >= notebook.cellCount) {
        return textResult(
          `afterIndex ${afterIndex} is out of range. ` +
            `Valid range is -1 to ${notebook.cellCount - 1}.`,
        );
      }
      insertAt = afterIndex + 1;
    } else {
      insertAt = notebook.cellCount;
    }

    const isMarkdown = options.input.kind === "markdown";
    const cellData = new vscode.NotebookCellData(
      isMarkdown ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code,
      source,
      isMarkdown ? "markdown" : "maxima",
    );
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [
      vscode.NotebookEdit.insertCells(insertAt, [cellData]),
    ]);

    const success = await vscode.workspace.applyEdit(edit);
    if (!success) {
      return textResult("Failed to insert cell into the notebook.");
    }

    return textResult(JSON.stringify({ cellIndex: insertAt, source }));
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<AddCellInput>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    const { source } = options.input;
    const preview =
      source.length > 60 ? source.substring(0, 60) + "…" : source;

    const dangerous = detectDangerousCalls(source);
    if (dangerous.length > 0) {
      const names = dangerous.join(", ");
      return {
        invocationMessage: `Adding cell: ${preview}`,
        confirmationMessages: {
          title: "Potentially Dangerous Code",
          message: new vscode.MarkdownString(
            `This cell uses **${names}** which can access the filesystem or run shell commands.\n\n` +
              `\`\`\`maxima\n${source}\n\`\`\`\n\nAdd this cell?`,
          ),
        },
      };
    }

    return {
      invocationMessage: `Adding cell: ${preview}`,
      confirmationMessages: {
        title: "Add Notebook Cell",
        message: new vscode.MarkdownString(
          `Add a new Maxima code cell?\n\n\`\`\`maxima\n${source}\n\`\`\``,
        ),
      },
    };
  }
}

// ── Registration ────────────────────────────────────────────────────

export function registerLmTools(
  controller: NotebookController,
): vscode.Disposable[] {
  return [
    vscode.lm.registerTool("maxima_notebook_get_cells", new GetCellsTool()),
    vscode.lm.registerTool(
      "maxima_notebook_run_cell",
      new RunCellTool(controller),
    ),
    vscode.lm.registerTool("maxima_notebook_add_cell", new AddCellTool()),
  ];
}
