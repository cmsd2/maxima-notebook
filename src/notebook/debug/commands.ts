/**
 * VS Code command handlers for notebook debugging.
 */

import * as vscode from "vscode";
import { isMaximaNotebook } from "./helpers";
import { launchDebugSession } from "./session";

export async function debugNotebook(): Promise<void> {
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  if (!notebook || !isMaximaNotebook(notebook)) {
    vscode.window.showWarningMessage("No active Maxima notebook.");
    return;
  }

  await launchDebugSession(notebook, "Debug Notebook");
}

export async function debugFromCell(
  cell?: vscode.NotebookCell,
): Promise<void> {
  if (!cell) {
    const editor = vscode.window.activeNotebookEditor;
    if (editor && editor.selections.length > 0) {
      cell = editor.notebook.cellAt(editor.selections[0].start);
    }
  }
  if (!cell) {
    vscode.window.showWarningMessage("No cell selected.");
    return;
  }

  const notebook = cell.notebook;
  if (!isMaximaNotebook(notebook)) {
    vscode.window.showWarningMessage("No active Maxima notebook.");
    return;
  }

  await launchDebugSession(notebook, "Debug From Cell", cell.index);
}
