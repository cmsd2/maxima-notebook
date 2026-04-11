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

// ── Input types ─────────────────────────────────────────────────────

interface RunCellInput {
  cellIndex: number;
}

interface AddCellInput {
  source: string;
  afterIndex?: number;
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

interface CellOutputInfo {
  text: string | null;
  latex: string | null;
  hasSvgPlot: boolean;
  hasPlotlyChart: boolean;
  error: string | null;
  isError: boolean;
}

function extractCellOutputs(cell: vscode.NotebookCell): CellOutputInfo {
  let text: string | null = null;
  let latex: string | null = null;
  let hasSvgPlot = false;
  let hasPlotlyChart = false;
  let error: string | null = null;
  let isError = false;

  const decoder = new TextDecoder();
  for (const output of cell.outputs) {
    for (const item of output.items) {
      switch (item.mime) {
        case "text/plain":
          text = decoder.decode(item.data);
          break;
        case "application/x-maxima-latex":
          latex = decoder.decode(item.data);
          break;
        case "image/svg+xml":
          hasSvgPlot = true;
          break;
        case "application/x-maxima-plotly":
          hasPlotlyChart = true;
          break;
        case "application/vnd.code.notebook.error": {
          isError = true;
          try {
            const errObj = JSON.parse(decoder.decode(item.data));
            error = errObj.message ?? errObj.name ?? "Error";
          } catch {
            error = "Error";
          }
          break;
        }
      }
    }
  }

  return { text, latex, hasSvgPlot, hasPlotlyChart, error, isError };
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
        cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown";
      const cellInfo: Record<string, unknown> = {
        index: i,
        kind,
        source: cell.document.getText(),
      };
      if (cell.kind === vscode.NotebookCellKind.Code) {
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
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      return textResult(
        `Cell ${cellIndex} is a markdown cell, not a code cell.`,
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
    return {
      invocationMessage: `Running cell ${options.input.cellIndex}…`,
      confirmationMessages: {
        title: "Run Notebook Cell",
        message: `Execute cell ${options.input.cellIndex} in the active Maxima notebook?`,
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

    const cellData = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      source,
      "maxima",
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
    const preview =
      options.input.source.length > 60
        ? options.input.source.substring(0, 60) + "…"
        : options.input.source;
    return {
      invocationMessage: `Adding cell: ${preview}`,
      confirmationMessages: {
        title: "Add Notebook Cell",
        message: new vscode.MarkdownString(
          `Add a new Maxima code cell?\n\n\`\`\`maxima\n${options.input.source}\n\`\`\``,
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
