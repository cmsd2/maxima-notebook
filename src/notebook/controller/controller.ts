/**
 * NotebookController for Maxima notebooks.
 *
 * Handles cell execution, kernel restart/interrupt, and notebook
 * session lifecycle via the McpProcessManager.
 */

import * as path from "path";
import * as vscode from "vscode";
import type { McpProcessManager } from "../mcpClient";
import { cellsAbove } from "../clientCells";
import { openCargoInstall } from "../../binaryManager";
import { MIN_TOOLS_VERSION } from "../../toolsVersion";
import { withTimeout } from "./outputs";
import {
  buildOutputs,
  cellMetadata,
  errorWithoutStack,
  isMaximaCode,
  outputFromResult,
  type CellMetadata,
} from "../notebookFile";

export const NOTEBOOK_TYPE = "maxima-notebook";
/** Compat type registered with "option" priority for .ipynb files. */
export const NOTEBOOK_TYPE_COMPAT = "maxima-notebook-compat";

/** File cell metadata the extension wrote before aximar-mcp numbered runs. */
const OLD_LABEL_KEYS = ["outputLabel", "executionCount"];

/** Session entry with generation tracking for stale session detection. */
interface SessionEntry {
  sessionId: string;
  generation: number;
}

export class NotebookController {
  private controllers: vscode.NotebookController[];
  /** The aximar-mcp generation the update prompt last showed for. */
  private updateOfferedFor = -1;
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

  // ── Cell execution ─────────────────────────────────────────────────

  private async executeCells(
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
    controller: vscode.NotebookController,
  ): Promise<void> {
    // Execute cells sequentially to maintain session state order
    let outdated = false;
    // Raw cells are text, never run
    for (const cell of cells.filter(isMaximaCode)) {
      if (outdated) {
        this.failOutdated(controller.createNotebookCellExecution(cell));
      } else {
        outdated = await this.executeCell(cell, notebook, controller);
      }
    }
    if (outdated) {
      await this.stopOutdated();
    }
  }

  /** Run one cell; true when aximar-mcp is too old to run it. */
  private async executeCell(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
    controller: vscode.NotebookController,
  ): Promise<boolean> {
    const execution = controller.createNotebookCellExecution(cell);
    execution.start(Date.now());

    try {
      // Ensure we have a session for this notebook
      const sessionId = await this.ensureSession(notebook);

      if (!this.mcpManager.supportsClientCells) {
        this.failOutdated(execution, true);
        void this.offerUpdate();
        return true;
      }

      // The server numbers the run and resolves %oN and % against the
      // cells above, so the source goes unchanged
      const refs = notebook.getCells().map((c) => ({
        id: c.document.uri.toString(),
        isCode: isMaximaCode(c),
      }));
      const timeoutMs =
        vscode.workspace
          .getConfiguration("maxima.notebook")
          .get<number>("evalTimeout", 60) * 1000;

      const evalResult = await withTimeout(
        this.mcpManager.evaluateExpression(cell.document.getText(), sessionId, {
          id: cell.document.uri.toString(),
          above: cellsAbove(refs, cell.index),
        }),
        timeoutMs,
        "Cell evaluation timed out",
      );

      if (evalResult.execution_count != null) {
        execution.executionOrder = evalResult.execution_count;
      }
      execution.replaceOutput(buildOutputs(outputFromResult(evalResult)));
      await this.clearRunMetadata(cell, notebook);
      execution.end(!evalResult.is_error, Date.now());
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      execution.replaceOutput([errorOutput(message)]);
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
      return false;
    }
  }

  /**
   * After a run, drop what belonged to the cell's earlier output: outputs
   * kept from the file that the extension doesn't show (Aximar drops them
   * on a run too), and the labels v0.3.0 stored, which no longer mean
   * anything.
   */
  private async clearRunMetadata(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    const current = cellMetadata(cell);
    const fileMetadata = current.metadata ?? {};
    const oldLabels = OLD_LABEL_KEYS.some((k) => k in fileMetadata);
    if (!oldLabels && current.otherOutputs === undefined) {
      return;
    }
    const metadata: CellMetadata = { ...current, metadata: { ...fileMetadata } };
    for (const k of OLD_LABEL_KEYS) {
      delete metadata.metadata![k];
    }
    delete metadata.otherOutputs;
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [
      vscode.NotebookEdit.updateCellMetadata(cell.index, metadata as { [key: string]: unknown }),
    ]);
    await vscode.workspace.applyEdit(edit);
  }

  // ── Outdated aximar-mcp ────────────────────────────────────────────

  private failOutdated(
    execution: vscode.NotebookCellExecution,
    started = false,
  ): void {
    if (!started) {
      execution.start(Date.now());
    }
    execution.replaceOutput([errorOutput(this.outdatedMessage())]);
    execution.end(false, Date.now());
  }

  /**
   * Stop an aximar-mcp that's too old, so the next run starts the binary
   * again and checks it: the user may have updated it or changed the path.
   */
  private async stopOutdated(): Promise<void> {
    for (const [uri, entry] of this.sessionMap) {
      if (entry.generation === this.mcpManager.generation) {
        this.sessionMap.delete(uri);
      }
    }
    await this.mcpManager.dispose();
  }

  private outdatedMessage(): string {
    return (
      `The aximar-mcp at "${this.mcpManager.command}" is too old to run notebook cells. ` +
      `Update the Maxima tools to ${MIN_TOOLS_VERSION} or later.`
    );
  }

  /** Offer the update once per aximar-mcp process, not once per cell. */
  private async offerUpdate(): Promise<void> {
    const generation = this.mcpManager.generation;
    if (this.updateOfferedFor === generation) {
      return;
    }
    this.updateOfferedFor = generation;
    const choice = await vscode.window.showErrorMessage(
      this.outdatedMessage(),
      "Download Update",
      "Install with cargo",
      "Open Settings",
    );
    if (choice === "Download Update") {
      await vscode.commands.executeCommand("maxima.downloadTools");
    } else if (choice === "Install with cargo") {
      openCargoInstall();
    } else if (choice === "Open Settings") {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "maxima.notebook.mcpPath",
      );
    }
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

    const notebookDir = notebook.isUntitled
      ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      : path.dirname(notebook.uri.fsPath);
    const sessionId = await this.mcpManager.createSession(notebookDir);
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
    if (!isMaximaCode(cell)) {
      throw new Error(`Cell ${cellIndex} is a markdown or raw cell, not a code cell`);
    }
    const ctrlIndex =
      notebook.notebookType === NOTEBOOK_TYPE ? 0 : 1;
    if (await this.executeCell(cell, notebook, this.controllers[ctrlIndex])) {
      await this.stopOutdated();
    }
  }

  // ── Kernel management ──────────────────────────────────────────────

  async restartKernel(notebook: vscode.NotebookDocument): Promise<void> {
    const uri = notebook.uri.toString();
    const entry = this.sessionMap.get(uri);
    if (entry) {
      await this.mcpManager.restartSession(entry.sessionId);
    }
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
  }

  dispose(): void {
    for (const ctrl of this.controllers) {
      ctrl.dispose();
    }
  }
}

function errorOutput(message: string): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.error(errorWithoutStack(message)),
  ]);
}
