/**
 * Export the active Maxima notebook to HTML or PDF via nbconvert.
 */

import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";

type ExportFormat = "maxima_html" | "maxima_pdf";

/**
 * Resolve the Python interpreter path using the VS Code Python extension API.
 * Falls back to "python3" if the Python extension isn't installed.
 */
async function getPythonPath(resource?: vscode.Uri): Promise<string> {
  try {
    const { PythonExtension } = await import("@vscode/python-extension");
    const api = await PythonExtension.api();
    const envPath = api.environments.getActiveEnvironmentPath(resource);
    const resolved = await api.environments.resolveEnvironment(envPath);
    if (resolved?.executable.uri) {
      return resolved.executable.uri.fsPath;
    }
    return envPath.path;
  } catch {
    return "python3";
  }
}

/**
 * Export a notebook document to the given format using jupyter nbconvert.
 */
export async function exportNotebook(
  notebook: vscode.NotebookDocument,
  format: ExportFormat,
): Promise<void> {
  // Ensure the notebook is saved
  if (notebook.isDirty) {
    const saved = await vscode.workspace.save(notebook.uri);
    if (!saved) {
      return;
    }
  }

  const ext = format === "maxima_pdf" ? "pdf" : "html";
  const defaultName = path.basename(
    notebook.uri.fsPath,
    path.extname(notebook.uri.fsPath),
  );

  const outputUri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(
      path.join(path.dirname(notebook.uri.fsPath), `${defaultName}.${ext}`),
    ),
    filters:
      ext === "html"
        ? { HTML: ["html"] }
        : { PDF: ["pdf"] },
  });

  if (!outputUri) {
    return;
  }

  const pythonPath = await getPythonPath(notebook.uri);
  const outputDir = path.dirname(outputUri.fsPath);
  const outputName = path.basename(outputUri.fsPath, `.${ext}`);

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting notebook to ${ext.toUpperCase()}…`,
      cancellable: false,
    },
    () =>
      runNbconvert(pythonPath, format, notebook.uri.fsPath, outputDir, outputName),
  );

  if (result.success) {
    const choice = await vscode.window.showInformationMessage(
      `Notebook exported to ${outputUri.fsPath}`,
      "Open",
    );
    if (choice === "Open") {
      vscode.env.openExternal(outputUri);
    }
  } else if (result.stderr.includes("No module named")) {
    const choice = await vscode.window.showErrorMessage(
      "jupyter nbconvert or maxima-nbconvert is not installed in the active Python environment.",
      "Show Install Instructions",
    );
    if (choice === "Show Install Instructions") {
      vscode.window.showInformationMessage(
        'Run: pip install "maxima-nbconvert[plotly]"',
      );
    }
  } else {
    vscode.window.showErrorMessage(
      `Export failed: ${result.stderr || result.stdout}`,
    );
  }
}

interface NbconvertResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

function runNbconvert(
  pythonPath: string,
  format: string,
  notebookPath: string,
  outputDir: string,
  outputName: string,
): Promise<NbconvertResult> {
  return new Promise((resolve) => {
    const args = [
      "-m",
      "jupyter",
      "nbconvert",
      "--to",
      format,
      "--output-dir",
      outputDir,
      "--output",
      outputName,
      notebookPath,
    ];

    const proc = spawn(pythonPath, args, {
      env: { ...process.env },
      cwd: path.dirname(notebookPath),
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    proc.on("close", (code) => {
      resolve({ success: code === 0, stdout, stderr });
    });
    proc.on("error", (err) => {
      resolve({ success: false, stdout, stderr: err.message });
    });
  });
}
