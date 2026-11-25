/**
 * NotebookSerializer for Maxima notebooks (.macnb, and .ipynb with a Maxima
 * kernel). The file format is Aximar's, read and written by the
 * `aximar-notebook-format` package; see notebookFile.ts.
 */

import * as vscode from "vscode";
import { notebookFromFile, notebookToFile } from "./notebookFile";

export class MaximaNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(
    content: Uint8Array,
    _token: vscode.CancellationToken,
  ): vscode.NotebookData {
    return notebookFromFile(new TextDecoder().decode(content));
  }

  serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken,
  ): Uint8Array {
    return new TextEncoder().encode(notebookToFile(data));
  }
}
