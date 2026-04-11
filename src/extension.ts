import * as vscode from "vscode";
import { execFileSync } from "child_process";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import { McpProcessManager } from "./notebook/mcpClient";
import { MaximaNotebookSerializer } from "./notebook/serializer";
import { NotebookController, NOTEBOOK_TYPE } from "./notebook/controller";

let client: LanguageClient | undefined;
let mcpManager: McpProcessManager | undefined;
let notebookController: NotebookController | undefined;

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

  // --- Debug adapter ---
  const dapFactory = new MaximaDapDescriptorFactory();
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("maxima", dapFactory),
  );
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      "maxima",
      new MaximaDebugConfigurationProvider(),
    ),
  );

  // --- Protocol output channel ---
  // maxima-dap sends filtered-out internal output (sentinels, prompts,
  // labels, breakpoint messages) as custom "maxima-output" DAP events.
  // Route them to a dedicated output channel so users can inspect the
  // full Maxima I/O when needed.
  const protocolOutput = vscode.window.createOutputChannel("Maxima Protocol");
  context.subscriptions.push(protocolOutput);
  context.subscriptions.push(
    vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
      if (e.session.type !== "maxima") {
        return;
      }
      if (e.event === "maxima-output") {
        const { category, output } = e.body ?? {};
        const prefix = category === "stdin" ? ">> " : "";
        protocolOutput.appendLine(`${prefix}${output ?? ""}`);
      }
    }),
  );

  // --- MCP token commands ---
  const MCP_TOKEN_KEY = "maxima.mcp.token";
  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.setMcpToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Enter the authorization token for the Maxima MCP server",
        password: true,
        ignoreFocusOut: true,
      });
      if (token !== undefined) {
        await context.secrets.store(MCP_TOKEN_KEY, token);
        mcpChanged.fire();
        vscode.window.showInformationMessage("Maxima MCP token saved.");
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.clearMcpToken", async () => {
      await context.secrets.delete(MCP_TOKEN_KEY);
      mcpChanged.fire();
      vscode.window.showInformationMessage("Maxima MCP token cleared.");
    }),
  );

  // --- Notebook support ---
  const notebookOutput = vscode.window.createOutputChannel("Maxima Notebook");
  context.subscriptions.push(notebookOutput);

  mcpManager = new McpProcessManager(notebookOutput);
  notebookController = new NotebookController(mcpManager);

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(
      NOTEBOOK_TYPE,
      new MaximaNotebookSerializer(),
      { transientOutputs: false },
    ),
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument((notebook) => {
      if (notebook.notebookType === NOTEBOOK_TYPE) {
        notebookController?.onNotebookOpen(notebook);
      }
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((notebook) => {
      if (notebook.notebookType === NOTEBOOK_TYPE) {
        notebookController?.onNotebookClose(notebook);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.notebook.new", async () => {
      const newDoc = await vscode.workspace.openNotebookDocument(
        NOTEBOOK_TYPE,
      );
      await vscode.window.showNotebookDocument(newDoc);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.notebook.restartKernel", () => {
      const notebook = vscode.window.activeNotebookEditor?.notebook;
      if (notebook && notebook.notebookType === NOTEBOOK_TYPE) {
        notebookController?.restartKernel(notebook);
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.notebook.interruptKernel", () => {
      const notebook = vscode.window.activeNotebookEditor?.notebook;
      if (notebook && notebook.notebookType === NOTEBOOK_TYPE) {
        notebookController?.interruptKernel(notebook);
      }
    }),
  );

  // --- MCP server provider ---
  const mcpChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(mcpChanged);
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("maxima.mcpServer", {
      onDidChangeMcpServerDefinitions: mcpChanged.event,
      provideMcpServerDefinitions() {
        const cfg = vscode.workspace.getConfiguration("maxima");
        const enabled = cfg.get<boolean>("mcp.enabled", false);
        if (!enabled) {
          return [];
        }
        const transport = cfg.get<string>("mcp.transport", "http");
        if (transport === "http") {
          const url = cfg
            .get<string>("mcp.url", "http://localhost:8000/mcp")
            .trim();
          if (!url) {
            return [];
          }
          return [
            new vscode.McpHttpServerDefinition(
              "Maxima MCP",
              vscode.Uri.parse(url),
            ),
          ];
        }
        const mcpPath = cfg.get<string>("mcp.path", "").trim();
        if (!mcpPath) {
          return [];
        }
        const mcpArgs = cfg.get<string[]>("mcp.args", []);
        return [
          new vscode.McpStdioServerDefinition(
            "Maxima MCP",
            mcpPath,
            mcpArgs,
          ),
        ];
      },
      async resolveMcpServerDefinition(server) {
        if (server instanceof vscode.McpHttpServerDefinition) {
          const token = await context.secrets.get(MCP_TOKEN_KEY);
          if (token) {
            server.headers = {
              ...server.headers,
              Authorization: `Bearer ${token}`,
            };
          }
        }
        return server;
      },
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("maxima.mcp")) {
        mcpChanged.fire();
      }
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
    documentSelector: [
      { scheme: "file", language: "maxima" },
      { scheme: "vscode-notebook-cell", language: "maxima" },
    ],
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
  if (notebookController) {
    notebookController.dispose();
    notebookController = undefined;
  }
  if (mcpManager) {
    await mcpManager.dispose();
    mcpManager = undefined;
  }
  if (client) {
    await client.stop();
    client = undefined;
  }
}

/**
 * Check if a command is available on PATH.
 */
function isCommandAvailable(command: string): boolean {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    execFileSync(which, [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the maxima-dap binary path and launches it as a stdio debug adapter.
 */
class MaximaDapDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const config = vscode.workspace.getConfiguration("maxima");
    const dapPath = config.get<string>("dap.path", "").trim();
    const command = dapPath || "maxima-dap";

    return new vscode.DebugAdapterExecutable(command, [], {
      env: {
        ...process.env,
        RUST_LOG: "maxima_dap=debug",
        MAXIMA_DAP_LOG: "/tmp/maxima-dap.log",
      },
    });
  }
}

/**
 * Provides default debug configuration when none exists, and resolves
 * configuration variables before launch.
 */
class MaximaDebugConfigurationProvider
  implements vscode.DebugConfigurationProvider
{
  /**
   * Called when the user starts debugging without a launch.json.
   * Returns a default configuration.
   */
  provideDebugConfigurations(
    _folder: vscode.WorkspaceFolder | undefined,
  ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
    return [
      {
        type: "maxima",
        request: "launch",
        name: "Debug Maxima File",
        program: "${file}",
        evaluate: "",
      },
    ];
  }

  /**
   * Resolves the debug configuration before the session starts.
   * Fills in defaults, validates the DAP binary, and maps extension settings.
   */
  async resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken,
  ): Promise<vscode.DebugConfiguration | undefined> {
    // If launched with no config (e.g. F5 with no launch.json)
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === "maxima") {
        config.type = "maxima";
        config.request = "launch";
        config.name = "Debug Maxima File";
        config.program = editor.document.uri.fsPath;
      } else {
        return undefined; // abort — no maxima file open
      }
    }

    // Validate that the maxima-dap binary can be found
    const extConfig = vscode.workspace.getConfiguration("maxima");
    const dapPath = extConfig.get<string>("dap.path", "").trim();
    const dapCommand = dapPath || "maxima-dap";

    if (dapPath) {
      // Explicit path configured — check if the file exists
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(dapPath));
      } catch {
        const choice = await vscode.window.showErrorMessage(
          `maxima-dap binary not found at "${dapPath}". ` +
            "Please install maxima-dap or update the path in settings.",
          "Open Settings",
        );
        if (choice === "Open Settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "maxima.dap.path",
          );
        }
        return undefined;
      }
    } else {
      // No explicit path — check if maxima-dap is on PATH
      if (!isCommandAvailable(dapCommand)) {
        const choice = await vscode.window.showErrorMessage(
          `"${dapCommand}" was not found on PATH. ` +
            "Install maxima-dap or set its path in settings " +
            "(Maxima > Dap: Path).",
          "Open Settings",
        );
        if (choice === "Open Settings") {
          vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "maxima.dap.path",
          );
        }
        return undefined;
      }
    }

    // Resolve maximaPath from launch config or extension settings
    if (!config.maximaPath) {
      const globalMaximaPath = extConfig.get<string>("maximaPath", "").trim();
      if (globalMaximaPath) {
        config.maximaPath = globalMaximaPath;
      }
    }

    return config;
  }
}
