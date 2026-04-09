import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // --- Run File command ---
  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.runFile", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor.");
        return;
      }
      const doc = editor.document;
      if (doc.isUntitled) {
        vscode.window.showWarningMessage(
          "Please save the file before running.",
        );
        return;
      }
      doc.save().then(() => {
        const filePath = doc.uri.fsPath;
        const terminal = vscode.window.createTerminal("Maxima");
        terminal.show();
        terminal.sendText(`maxima --very-quiet --batch "${filePath}"`);
      });
    }),
  );

  // --- LSP client ---
  const config = vscode.workspace.getConfiguration("maxima");
  const lspEnabled = config.get<boolean>("lsp.enabled", true);

  if (!lspEnabled) {
    return;
  }

  const lspPath = config.get<string>("lsp.path", "").trim();
  const command = lspPath || "maxima-lsp";

  // Verify the binary exists if a custom path was given
  if (lspPath) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(lspPath));
    } catch {
      const choice = await vscode.window.showWarningMessage(
        `maxima-lsp binary not found at "${lspPath}". ` +
          "Language features are disabled.",
        "Open Settings",
      );
      if (choice === "Open Settings") {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "maxima.lsp",
        );
      }
      return;
    }
  }

  const serverOptions: ServerOptions = {
    command,
    args: [],
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "maxima" }],
  };

  client = new LanguageClient(
    "maxima-lsp",
    "Maxima Language Server",
    serverOptions,
    clientOptions,
  );

  try {
    await client.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const choice = await vscode.window.showWarningMessage(
      `Failed to start maxima-lsp: ${message}. ` +
        "Language features are disabled.",
      "Open Settings",
    );
    if (choice === "Open Settings") {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "maxima.lsp",
      );
    }
    client = undefined;
  }
}

export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}
