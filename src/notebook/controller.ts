/**
 * NotebookController for Maxima notebooks.
 *
 * Handles cell execution, kernel restart/interrupt, and notebook
 * session lifecycle via the McpProcessManager.
 */

import * as vscode from "vscode";
import type { McpProcessManager } from "./mcpClient";
import type { EvalResult, LabelContext, MaximaCellMetadata } from "./types";
import { rewriteLabels } from "./labels";

export const NOTEBOOK_TYPE = "maxima-notebook";
/** Compat type registered with "option" priority for .ipynb files. */
export const NOTEBOOK_TYPE_COMPAT = "maxima-notebook-compat";

/** Per-notebook execution state. */
interface NotebookState {
  executionOrder: number;
  labelMap: Map<number, string>;
}

/** Session entry with generation tracking for stale session detection. */
interface SessionEntry {
  sessionId: string;
  generation: number;
}

export class NotebookController {
  private controllers: vscode.NotebookController[];
  /** Per-notebook execution state keyed by notebook URI. */
  private notebookState = new Map<string, NotebookState>();
  /** Maps notebook URI → aximar-mcp session entry. */
  private sessionMap = new Map<string, SessionEntry>();

  constructor(private mcpManager: McpProcessManager) {
    const handler = this.executeCells.bind(this);
    this.controllers = [NOTEBOOK_TYPE, NOTEBOOK_TYPE_COMPAT].map(
      (type, i) => {
        const ctrl = vscode.notebooks.createNotebookController(
          i === 0 ? "maxima-kernel" : "maxima-kernel-compat",
          type,
          "Maxima",
        );
        ctrl.supportedLanguages = ["maxima"];
        ctrl.supportsExecutionOrder = true;
        ctrl.executeHandler = handler;
        return ctrl;
      },
    );
  }

  // ── Per-notebook state ─────────────────────────────────────────────

  private getState(notebook: vscode.NotebookDocument): NotebookState {
    const uri = notebook.uri.toString();
    let state = this.notebookState.get(uri);
    if (!state) {
      state = { executionOrder: 0, labelMap: new Map() };
      this.notebookState.set(uri, state);
    }
    return state;
  }

  // ── Cell execution ─────────────────────────────────────────────────

  private async executeCells(
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
    controller: vscode.NotebookController,
  ): Promise<void> {
    // Execute cells sequentially to maintain session state order
    for (const cell of cells) {
      await this.executeCell(cell, notebook, controller);
    }
  }

  private async executeCell(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
    controller: vscode.NotebookController,
  ): Promise<void> {
    const state = this.getState(notebook);
    const execution = controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++state.executionOrder;
    execution.start(Date.now());

    try {
      // Ensure we have a session for this notebook
      const sessionId = await this.ensureSession(notebook);

      // Build label context
      const ctx = this.buildLabelContext(cell, notebook, state);

      // Rewrite labels in the source
      const source = cell.document.getText();
      const rewritten = rewriteLabels(source, ctx);

      // Evaluate with timeout
      const timeoutMs =
        vscode.workspace
          .getConfiguration("maxima.notebook")
          .get<number>("evalTimeout", 60) * 1000;

      const evalResult = await withTimeout(
        this.mcpManager.evaluateExpression(rewritten, sessionId),
        timeoutMs,
        "Cell evaluation timed out",
      );

      // Record label mapping
      if (evalResult.output_label) {
        state.labelMap.set(state.executionOrder, evalResult.output_label);
      }

      // Store metadata on the cell
      const metadata: MaximaCellMetadata = {
        outputLabel: evalResult.output_label ?? undefined,
        executionCount: state.executionOrder,
      };
      execution.executionOrder = state.executionOrder;

      // Build output items
      const outputs = this.buildOutputs(evalResult);
      execution.replaceOutput(outputs);

      // Update cell metadata via notebook edit
      const edit = new vscode.WorkspaceEdit();
      const cellMetadata = { ...cell.metadata, ...metadata };
      const notebookEdit = vscode.NotebookEdit.updateCellMetadata(
        cell.index,
        cellMetadata,
      );
      edit.set(notebook.uri, [notebookEdit]);
      await vscode.workspace.applyEdit(edit);

      execution.end(!evalResult.is_error, Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      execution.replaceOutput([
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.error(new Error(message)),
        ]),
      ]);
      execution.end(false, Date.now());

      // Show notification for startup failures so the user can fix settings
      if (
        message.includes("Failed to spawn") ||
        message.includes("Failed to connect")
      ) {
        const action = await vscode.window.showErrorMessage(
          `Maxima notebook: ${message}`,
          "Open Settings",
        );
        if (action === "Open Settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "maxima.notebook.mcpPath",
          );
        }
      }
    }
  }

  // ── Output building ────────────────────────────────────────────────

  private buildOutputs(result: EvalResult): vscode.NotebookCellOutput[] {
    if (result.is_error) {
      const message = result.error || result.text_output || "Evaluation error";
      return [
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.error(new Error(message)),
        ]),
      ];
    }

    const outputs: vscode.NotebookCellOutput[] = [];

    // Main result output (text and/or latex)
    const items: vscode.NotebookCellOutputItem[] = [];

    if (result.text_output) {
      items.push(
        vscode.NotebookCellOutputItem.text(result.text_output, "text/plain"),
      );
    }

    if (result.latex) {
      items.push(
        vscode.NotebookCellOutputItem.text(
          result.latex,
          "application/x-maxima-latex",
        ),
      );
      // Plain text fallback for environments without the renderer
      if (!result.text_output) {
        items.push(
          vscode.NotebookCellOutputItem.text(result.latex, "text/plain"),
        );
      }
    }

    if (items.length > 0) {
      outputs.push(new vscode.NotebookCellOutput(items));
    }

    // SVG plot — renders natively in VS Code
    if (result.plot_svg) {
      outputs.push(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(
            result.plot_svg,
            "image/svg+xml",
          ),
        ]),
      );
    }

    // Plotly data — interactive chart via custom renderer
    if (result.plot_data) {
      outputs.push(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(
            result.plot_data,
            "application/x-maxima-plotly",
          ),
          vscode.NotebookCellOutputItem.text(result.plot_data, "text/plain"),
        ]),
      );
    }

    return outputs;
  }

  // ── Label context ──────────────────────────────────────────────────

  private buildLabelContext(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
    state: NotebookState,
  ): LabelContext {
    // Find the previous code cell's output label
    let previousOutputLabel: string | undefined;
    for (let i = cell.index - 1; i >= 0; i--) {
      const prevCell = notebook.cellAt(i);
      if (prevCell.kind === vscode.NotebookCellKind.Code) {
        const meta = prevCell.metadata as MaximaCellMetadata | undefined;
        previousOutputLabel = meta?.outputLabel;
        break;
      }
    }

    return {
      labelMap: state.labelMap,
      previousOutputLabel,
    };
  }

  // ── Session management ─────────────────────────────────────────────

  private async ensureSession(
    notebook: vscode.NotebookDocument,
  ): Promise<string> {
    const uri = notebook.uri.toString();
    const entry = this.sessionMap.get(uri);

    await this.mcpManager.ensureRunning();

    // If the MCP process restarted, the old session is stale
    const currentGen = this.mcpManager.generation;
    if (entry && entry.generation === currentGen) {
      return entry.sessionId;
    }

    const sessionId = await this.mcpManager.createSession();
    this.sessionMap.set(uri, { sessionId, generation: currentGen });
    return sessionId;
  }

  // ── Programmatic execution (for LM tools) ─────────────────────────

  async executeCellByIndex(
    notebook: vscode.NotebookDocument,
    cellIndex: number,
  ): Promise<void> {
    if (cellIndex < 0 || cellIndex >= notebook.cellCount) {
      throw new Error(
        `Cell index ${cellIndex} out of range (0..${notebook.cellCount - 1})`,
      );
    }
    const cell = notebook.cellAt(cellIndex);
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      throw new Error(`Cell ${cellIndex} is a markup cell, not a code cell`);
    }
    const ctrlIndex =
      notebook.notebookType === NOTEBOOK_TYPE ? 0 : 1;
    await this.executeCell(cell, notebook, this.controllers[ctrlIndex]);
  }

  // ── Kernel management ──────────────────────────────────────────────

  async restartKernel(notebook: vscode.NotebookDocument): Promise<void> {
    const uri = notebook.uri.toString();
    const entry = this.sessionMap.get(uri);
    if (entry) {
      await this.mcpManager.restartSession(entry.sessionId);
    }
    // Reset only this notebook's execution state
    this.notebookState.delete(uri);
  }

  async interruptKernel(_notebook: vscode.NotebookDocument): Promise<void> {
    // aximar-mcp doesn't support interrupting a running evaluation yet.
    // For now, show a message. A future version could send a cancel signal.
    vscode.window.showInformationMessage(
      "Interrupt is not yet supported. Use Restart Kernel to stop long-running evaluations.",
    );
  }

  // ── Notebook lifecycle ─────────────────────────────────────────────

  async onNotebookOpen(_notebook: vscode.NotebookDocument): Promise<void> {
    // Session is created lazily on first cell execution
  }

  async onNotebookClose(notebook: vscode.NotebookDocument): Promise<void> {
    const uri = notebook.uri.toString();
    const entry = this.sessionMap.get(uri);
    if (entry) {
      try {
        await this.mcpManager.closeSession(entry.sessionId);
      } catch {
        // Ignore — process may already be dead
      }
      this.sessionMap.delete(uri);
    }
    this.notebookState.delete(uri);
  }

  dispose(): void {
    for (const ctrl of this.controllers) {
      ctrl.dispose();
    }
  }
}

// ── Utilities ───────────────────────────────────────────────────────

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
