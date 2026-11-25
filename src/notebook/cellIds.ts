/**
 * Every cell in a Maxima notebook has a stable ID (nbformat 4.5), written
 * to the file and kept when it's read. Cells added in VS Code get one as
 * they're added, and a pasted copy gets its own instead of its source's.
 */

import * as vscode from "vscode";
import { newId, validId } from "aximar-notebook-format";
import { cellMetadata, type CellMetadata } from "./notebookFile";

/** Give added cells IDs in notebooks of these types. */
export function registerCellIds(notebookTypes: readonly string[]): vscode.Disposable {
  return vscode.workspace.onDidChangeNotebookDocument((event) => {
    const notebook = event.notebook;
    if (!notebookTypes.includes(notebook.notebookType)) {
      return;
    }
    const added = event.contentChanges.flatMap((change) => change.addedCells);
    if (added.length === 0) {
      return;
    }
    const edits = cellIdEdits(notebook.getCells(), new Set(added));
    if (edits.length > 0) {
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, edits);
      void vscode.workspace.applyEdit(edit);
    }
  });
}

/**
 * Edits giving each added cell a usable ID: one that's valid and that no
 * other cell has. Cells already in the notebook keep theirs.
 */
export function cellIdEdits(
  cells: readonly vscode.NotebookCell[],
  added: ReadonlySet<vscode.NotebookCell>,
): vscode.NotebookEdit[] {
  const taken = new Set<string>();
  for (const cell of cells) {
    const id = cellMetadata(cell).id;
    if (!added.has(cell) && id) {
      taken.add(id);
    }
  }
  const edits: vscode.NotebookEdit[] = [];
  for (const cell of cells) {
    if (!added.has(cell)) {
      continue;
    }
    const current = cellMetadata(cell);
    if (current.id && validId(current.id) && !taken.has(current.id)) {
      taken.add(current.id);
      continue;
    }
    const metadata: CellMetadata = { ...current, id: newId() };
    taken.add(metadata.id!);
    edits.push(
      vscode.NotebookEdit.updateCellMetadata(cell.index, metadata as { [key: string]: unknown }),
    );
  }
  return edits;
}
