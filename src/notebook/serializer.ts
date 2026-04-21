/**
 * NotebookSerializer for Maxima .ipynb files.
 *
 * Converts between the ipynb JSON format and VS Code's NotebookData model.
 */

import * as vscode from "vscode";
import type { IpynbNotebook, IpynbCell, IpynbOutput } from "./types";

const MAXIMA_KERNELSPEC = {
  display_name: "Maxima",
  language: "maxima",
  name: "maxima",
};

export class MaximaNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(
    content: Uint8Array,
    _token: vscode.CancellationToken,
  ): vscode.NotebookData {
    const text = new TextDecoder().decode(content).trim();

    if (!text) {
      return new vscode.NotebookData([
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          "",
          "maxima",
        ),
      ]);
    }

    let notebook: IpynbNotebook;
    try {
      notebook = JSON.parse(text);
    } catch {
      return new vscode.NotebookData([
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          "",
          "maxima",
        ),
      ]);
    }

    const cells: vscode.NotebookCellData[] = [];
    for (const cell of notebook.cells ?? []) {
      if (cell.cell_type === "raw") {
        continue;
      }

      const source = joinSource(cell.source);
      const kind =
        cell.cell_type === "markdown"
          ? vscode.NotebookCellKind.Markup
          : vscode.NotebookCellKind.Code;
      const languageId = kind === vscode.NotebookCellKind.Code ? "maxima" : "markdown";

      const cellData = new vscode.NotebookCellData(kind, source, languageId);

      // Restore outputs
      if (cell.outputs && cell.outputs.length > 0) {
        cellData.outputs = cell.outputs
          .map((o) => deserializeOutput(o))
          .filter((o): o is vscode.NotebookCellOutput => o !== undefined);
      }

      // Restore execution count
      if (cell.execution_count != null) {
        cellData.executionSummary = {
          executionOrder: cell.execution_count,
        };
      }

      // Pass through cell metadata
      if (cell.metadata && Object.keys(cell.metadata).length > 0) {
        cellData.metadata = cell.metadata;
      }

      cells.push(cellData);
    }

    if (cells.length === 0) {
      cells.push(
        new vscode.NotebookCellData(
          vscode.NotebookCellKind.Code,
          "",
          "maxima",
        ),
      );
    }

    const notebookData = new vscode.NotebookData(cells);
    notebookData.metadata = notebook.metadata;
    return notebookData;
  }

  serializeNotebook(
    data: vscode.NotebookData,
    _token: vscode.CancellationToken,
  ): Uint8Array {
    const cells: IpynbCell[] = data.cells.map((cell) => {
      const cellType =
        cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code";
      const ipynbCell: IpynbCell = {
        cell_type: cellType,
        source: splitSource(cell.value),
        metadata: cell.metadata ?? {},
      };

      if (cellType === "code") {
        ipynbCell.execution_count =
          cell.executionSummary?.executionOrder ?? null;
        ipynbCell.outputs = (cell.outputs ?? []).map((o) => serializeOutput(o));
      }

      return ipynbCell;
    });

    const notebook: IpynbNotebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        ...(data.metadata ?? {}),
        kernelspec: MAXIMA_KERNELSPEC,
      },
      cells,
    };

    const json = JSON.stringify(notebook, undefined, 1) + "\n";
    return new TextEncoder().encode(json);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function joinSource(source: string | string[]): string {
  if (Array.isArray(source)) {
    return source.join("");
  }
  return source ?? "";
}

function splitSource(source: string): string[] {
  if (!source) {
    return [""];
  }
  // Split on newlines, keeping the newline at end of each line (ipynb convention)
  const lines = source.split(/(?<=\n)/);
  // Ensure last element isn't empty from trailing newline
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function deserializeOutput(
  output: IpynbOutput,
): vscode.NotebookCellOutput | undefined {
  if (output.output_type === "execute_result" || output.output_type === "display_data") {
    const items: vscode.NotebookCellOutputItem[] = [];
    const data = output.data ?? {};

    for (const [mime, content] of Object.entries(data)) {
      const text = Array.isArray(content) ? content.join("") : content;
      if (mime === "image/png") {
        // nbformat stores image data as base64; VS Code expects raw bytes
        const bytes = Buffer.from(text, "base64");
        items.push(new vscode.NotebookCellOutputItem(bytes, "image/png"));
      } else {
        // Remap text/latex → application/x-maxima-latex for our renderer
        const mappedMime =
          mime === "text/latex" ? "application/x-maxima-latex" : mime;
        items.push(
          vscode.NotebookCellOutputItem.text(text, mappedMime),
        );
      }
    }

    if (items.length > 0) {
      const cellOutput = new vscode.NotebookCellOutput(items);
      if (output.execution_count != null) {
        cellOutput.metadata = {
          ...cellOutput.metadata,
          execution_count: output.execution_count,
        };
      }
      return cellOutput;
    }
  }

  if (output.output_type === "stream") {
    const text = (output.text ?? []).join("");
    if (text) {
      return new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(text, "text/plain"),
      ]);
    }
  }

  if (output.output_type === "error") {
    const message = [output.ename, output.evalue].filter(Boolean).join(": ");
    return new vscode.NotebookCellOutput([
      vscode.NotebookCellOutputItem.error(
        new Error(message || "Unknown error"),
      ),
    ]);
  }

  return undefined;
}

function serializeOutput(output: vscode.NotebookCellOutput): IpynbOutput {
  // Check for error items first
  const errorItem = output.items.find(
    (item) => item.mime === "application/vnd.code.notebook.error",
  );
  if (errorItem) {
    try {
      const err = JSON.parse(new TextDecoder().decode(errorItem.data));
      return {
        output_type: "error",
        ename: err.name ?? "Error",
        evalue: err.message ?? "",
        traceback: err.stack ? err.stack.split("\n") : [],
      };
    } catch {
      return {
        output_type: "error",
        ename: "Error",
        evalue: "",
        traceback: [],
      };
    }
  }

  // Build MIME data bundle
  const data: Record<string, string[]> = {};
  for (const item of output.items) {
    if (item.mime === "image/png") {
      // Store as base64 for nbformat compatibility
      const b64 = Buffer.from(item.data).toString("base64");
      data["image/png"] = [b64];
    } else {
      const text = new TextDecoder().decode(item.data);
      // Remap our custom MIME back to standard for ipynb compat
      const mime =
        item.mime === "application/x-maxima-latex" ? "text/latex" : item.mime;
      data[mime] = splitSource(text);
    }
  }

  // Ensure text/plain fallback exists
  if (!data["text/plain"] && Object.keys(data).length > 0) {
    const firstMime = Object.keys(data)[0];
    data["text/plain"] = data[firstMime];
  }

  return {
    output_type: "execute_result",
    data,
    metadata: output.metadata ?? {},
    execution_count: output.metadata?.execution_count as number | null ?? null,
  };
}
