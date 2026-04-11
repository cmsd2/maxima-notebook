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

export class NotebookController {
  private controller: vscode.NotebookController;
  private executionOrder = 0;
  /** Maps display execution count → real Maxima output label */
  private labelMap = new Map<number, string>();
  /** Maps notebook URI → aximar-mcp session ID */
  private sessionMap = new Map<string, string>();

  constructor(private mcpManager: McpProcessManager) {
    this.controller = vscode.notebooks.createNotebookController(
      "maxima-kernel",
      NOTEBOOK_TYPE,
      "Maxima",
    );
    this.controller.supportedLanguages = ["maxima"];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = this.executeCells.bind(this);
  }

  // ── Cell execution ─────────────────────────────────────────────────

  private async executeCells(
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
    _controller: vscode.NotebookController,
  ): Promise<void> {
    // Execute cells sequentially to maintain session state order
    for (const cell of cells) {
      await this.executeCell(cell, notebook);
    }
  }

  private async executeCell(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    const execution = this.controller.createNotebookCellExecution(cell);
    execution.executionOrder = ++this.executionOrder;
    execution.start(Date.now());

    try {
      // Ensure we have a session for this notebook
      const sessionId = await this.ensureSession(notebook);

      // Build label context
      const ctx = this.buildLabelContext(cell, notebook);

      // Rewrite labels in the source
      const source = cell.document.getText();
      const rewritten = rewriteLabels(source, ctx);

      // Evaluate
      const evalResult = await this.mcpManager.evaluateExpression(
        rewritten,
        sessionId,
      );

      // Record label mapping
      if (evalResult.output_label) {
        this.labelMap.set(this.executionOrder, evalResult.output_label);
      }

      // Store metadata on the cell
      const metadata: MaximaCellMetadata = {
        outputLabel: evalResult.output_label ?? undefined,
        executionCount: this.executionOrder,
      };
      execution.executionOrder = this.executionOrder;

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
      labelMap: this.labelMap,
      previousOutputLabel,
    };
  }

  // ── Session management ─────────────────────────────────────────────

  private async ensureSession(
    notebook: vscode.NotebookDocument,
  ): Promise<string> {
    const uri = notebook.uri.toString();
    let sessionId = this.sessionMap.get(uri);
    if (sessionId) {
      return sessionId;
    }

    await this.mcpManager.ensureRunning();
    sessionId = await this.mcpManager.createSession();
    this.sessionMap.set(uri, sessionId);
    return sessionId;
  }

  // ── Kernel management ──────────────────────────────────────────────

  async restartKernel(notebook: vscode.NotebookDocument): Promise<void> {
    const uri = notebook.uri.toString();
    const sessionId = this.sessionMap.get(uri);
    if (sessionId) {
      await this.mcpManager.restartSession(sessionId);
    }
    // Reset execution counters and label map
    this.executionOrder = 0;
    this.labelMap.clear();
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
    const sessionId = this.sessionMap.get(uri);
    if (sessionId) {
      try {
        await this.mcpManager.closeSession(sessionId);
      } catch {
        // Ignore — process may already be dead
      }
      this.sessionMap.delete(uri);
    }
  }

  dispose(): void {
    this.controller.dispose();
  }
}
