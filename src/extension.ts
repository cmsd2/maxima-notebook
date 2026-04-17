import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import { McpProcessManager } from "./notebook/mcpClient";
import { MaximaNotebookSerializer } from "./notebook/serializer";
import {
  NotebookController,
  NOTEBOOK_TYPE,
  NOTEBOOK_TYPE_COMPAT,
  registerLmTools,
} from "./notebook/controller";
import {
  debugNotebook,
  debugFromCell,
  registerDebugAdapterTracker,
  registerDebugLmTools,
} from "./notebook/debug";
import { BinaryManager } from "./binaryManager";
import { DapProcessAdapter } from "./notebook/debug/dapAdapter";
import { searchDocumentation } from "./searchDocs";

let client: LanguageClient | undefined;
let mcpManager: McpProcessManager | undefined;
let notebookController: NotebookController | undefined;
let binaryManager: BinaryManager | undefined;

/** Resolves once the window has focus, or immediately if already focused. */
function whenWindowReady(): Promise<void> {
  if (vscode.window.state.focused) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const d = vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        d.dispose();
        resolve();
      }
    });
  });
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // --- Binary manager ---
  binaryManager = new BinaryManager(context.globalStorageUri);

  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.downloadTools", async () => {
      const ok = await binaryManager?.downloadTools();
      if (ok) {
        await restartClient();
      }
    }),
  );

  // Non-blocking: check for Maxima and prompt to install missing tools.
  // Wait for the window to be focused so notifications aren't swallowed
  // when VS Code restores a session and activates the extension during startup.
  whenWindowReady().then(() => {
    binaryManager?.checkMaximaInstalled();
    binaryManager?.promptInstallIfNeeded();
  });
  // Non-blocking: check for updates after a longer delay
  setTimeout(async () => {
    const updated = await binaryManager?.checkForUpdates();
    if (updated && client) {
      await restartClient();
    }
  }, 5000);

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
  // maxima-dap tracing logs (stderr) are captured by DapProcessAdapter.
  const dapOutput = vscode.window.createOutputChannel("Maxima Debug Adapter");
  context.subscriptions.push(dapOutput);
  const dapFactory = new MaximaDapDescriptorFactory(binaryManager, dapOutput);
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory("maxima", dapFactory),
  );
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      "maxima",
      new MaximaDebugConfigurationProvider(),
    ),
  );
  context.subscriptions.push(registerDebugAdapterTracker());

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

  // --- Notebook support ---
  const notebookOutput = vscode.window.createOutputChannel("Maxima Notebook");
  context.subscriptions.push(notebookOutput);

  mcpManager = new McpProcessManager(notebookOutput, () =>
    binaryManager?.resolveTool("aximar-mcp"),
  );
  notebookController = new NotebookController(mcpManager);

  // Register LM tools for AI agents
  for (const d of registerLmTools(notebookController)) {
    context.subscriptions.push(d);
  }
  for (const d of registerDebugLmTools()) {
    context.subscriptions.push(d);
  }

  const notebookTypes = [NOTEBOOK_TYPE, NOTEBOOK_TYPE_COMPAT];
  const serializer = new MaximaNotebookSerializer();
  for (const type of notebookTypes) {
    context.subscriptions.push(
      vscode.workspace.registerNotebookSerializer(type, serializer, {
        transientOutputs: false,
      }),
    );
  }

  const isMaximaNotebook = (notebook: vscode.NotebookDocument) =>
    notebookTypes.includes(notebook.notebookType);

  context.subscriptions.push(
    vscode.workspace.onDidOpenNotebookDocument((notebook) => {
      if (isMaximaNotebook(notebook)) {
        notebookController?.onNotebookOpen(notebook);
      }
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidCloseNotebookDocument((notebook) => {
      if (isMaximaNotebook(notebook)) {
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
      if (notebook && isMaximaNotebook(notebook)) {
        notebookController?.restartKernel(notebook);
      }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.notebook.interruptKernel", () => {
      const notebook = vscode.window.activeNotebookEditor?.notebook;
      if (notebook && isMaximaNotebook(notebook)) {
        notebookController?.interruptKernel(notebook);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.notebook.debugNotebook", () => {
      debugNotebook();
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "maxima.notebook.debugFromCell",
      (cell: vscode.NotebookCell) => {
        debugFromCell(cell);
      },
    ),
  );

  // --- MCP server provider ---
  const mcpChanged = new vscode.EventEmitter<void>();
  context.subscriptions.push(mcpChanged);

  // Forward managed process start/stop to the MCP provider
  context.subscriptions.push(
    mcpManager.onDidChangeRunning(() => mcpChanged.fire()),
  );

  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("maxima.mcpServer", {
      onDidChangeMcpServerDefinitions: mcpChanged.event,
      provideMcpServerDefinitions() {
        if (!mcpManager?.isRunning()) {
          return [];
        }
        const port = mcpManager.getPort();
        if (!port) {
          return [];
        }
        return [
          new vscode.McpHttpServerDefinition(
            "Maxima Notebook",
            vscode.Uri.parse(`http://localhost:${port}/mcp`),
          ),
        ];
      },
      resolveMcpServerDefinition(server) {
        if (server instanceof vscode.McpHttpServerDefinition) {
          const token = mcpManager?.getToken();
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

  // --- LSP client ---
  const config = vscode.workspace.getConfiguration("maxima");
  const lspEnabled = config.get<boolean>("lsp.enabled", true);

  if (!lspEnabled) {
    return;
  }

  const command = binaryManager?.resolveTool("maxima-lsp");
  if (!command) {
    // No binary found anywhere — skip LSP silently (the install prompt
    // from promptInstallIfNeeded() will guide the user)
    return;
  }

  // Verify the binary exists if an absolute path was resolved
  if (command.includes("/") || command.includes("\\")) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(command));
    } catch {
      const choice = await vscode.window.showWarningMessage(
        `maxima-lsp binary not found at "${command}". ` +
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

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "maxima" },
      { scheme: "vscode-notebook-cell", language: "maxima" },
    ],
  };

  /** Create (or recreate) the LSP client with the currently resolved binary. */
  function createClient(): LanguageClient {
    const cmd = binaryManager?.resolveTool("maxima-lsp") ?? command!;
    return new LanguageClient(
      "maxima-lsp",
      "Maxima Language Server",
      { command: cmd, args: [] },
      clientOptions,
    );
  }

  /** Stop the current client (if any) and start a fresh one. */
  async function restartClient(): Promise<void> {
    if (client) {
      await client.stop();
    }
    client = createClient();
    await client.start();
  }

  client = createClient();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("maxima.lsp.path")) {
        await restartClient();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.restartLsp", async () => {
      try {
        await restartClient();
        vscode.window.showInformationMessage("Maxima language server restarted.");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showWarningMessage(
          `Failed to restart maxima-lsp: ${message}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("maxima.searchDocs", () => {
      if (client) {
        searchDocumentation(client);
      } else {
        vscode.window.showWarningMessage(
          "Maxima language server is not running.",
        );
      }
    }),
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
 * Resolves the maxima-dap binary path and launches it as a stdio debug adapter.
 */
class MaximaDapDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  private bm: BinaryManager | undefined;
  private outputChannel: vscode.OutputChannel;

  constructor(bm: BinaryManager | undefined, outputChannel: vscode.OutputChannel) {
    this.bm = bm;
    this.outputChannel = outputChannel;
  }

  createDebugAdapterDescriptor(
    _session: vscode.DebugSession,
    _executable: vscode.DebugAdapterExecutable | undefined,
  ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
    const command = this.bm?.resolveTool("maxima-dap") ?? "maxima-dap";

    const adapter = new DapProcessAdapter(command, this.outputChannel, {
      ...process.env,
      RUST_LOG: "maxima_dap=debug",
    });

    return new vscode.DebugAdapterInlineImplementation(adapter);
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
    const dapCommand = binaryManager?.resolveTool("maxima-dap");
    if (!dapCommand) {
      const choice = await vscode.window.showErrorMessage(
        "maxima-dap was not found. " +
          "Install Maxima tools or set the path in settings " +
          "(Maxima > Dap: Path).",
        "Download Tools",
        "Open Settings",
      );
      if (choice === "Download Tools") {
        vscode.commands.executeCommand("maxima.downloadTools");
      } else if (choice === "Open Settings") {
        vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "maxima.dap.path",
        );
      }
      return undefined;
    }

    // Resolve maximaPath from launch config or extension settings
    if (!config.maximaPath) {
      const extConfig = vscode.workspace.getConfiguration("maxima");
      const globalMaximaPath = extConfig.get<string>("maximaPath", "").trim();
      if (globalMaximaPath) {
        config.maximaPath = globalMaximaPath;
      }
    }

    return config;
  }
}
