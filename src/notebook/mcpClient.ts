/**
 * Manages a single aximar-mcp process (simple mode, HTTP) and
 * provides typed wrappers for MCP tool calls.
 */

import { ChildProcess, spawn } from "child_process";
import * as vscode from "vscode";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { EvalResult } from "./types";

const SPAWN_TIMEOUT_MS = 15_000;

/** JSON line printed to stdout by aximar-mcp on startup */
interface ServerStartupInfo {
  port: number;
  token: string | null;
}

export class McpProcessManager {
  private process: ChildProcess | undefined;
  private client: Client | undefined;
  private port: number | undefined;
  private token: string | undefined;
  private _running = false;
  private _generation = 0;
  private outputChannel: vscode.OutputChannel;

  private readonly _onDidChangeRunning = new vscode.EventEmitter<void>();
  readonly onDidChangeRunning: vscode.Event<void> =
    this._onDidChangeRunning.event;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  private get mcpPath(): string {
    const cfg = vscode.workspace.getConfiguration("maxima.notebook");
    return cfg.get<string>("mcpPath", "") || "aximar-mcp";
  }

  async ensureRunning(): Promise<void> {
    if (this._running && this.process && this.process.exitCode === null) {
      return;
    }
    // Process died or never started — (re)spawn
    await this.dispose();
    await this.spawnAndConnect();
  }

  isRunning(): boolean {
    return this._running && this.process !== undefined && this.process.exitCode === null;
  }

  /** Monotonically increasing counter, incremented on each process spawn. */
  get generation(): number {
    return this._generation;
  }

  getPort(): number | undefined {
    return this.port;
  }

  getToken(): string | undefined {
    return this.token;
  }

  // ── Tool wrappers ──────────────────────────────────────────────────

  async evaluateExpression(expression: string, sessionId?: string): Promise<EvalResult> {
    const args: Record<string, string> = { expression };
    if (sessionId) {
      args.session_id = sessionId;
    }
    const result = await this.callTool("evaluate_expression", args);
    return JSON.parse(result) as EvalResult;
  }

  async createSession(): Promise<string> {
    const result = await this.callTool("create_session", {});
    // aximar-mcp returns the session_id as a plain string or JSON
    try {
      const parsed = JSON.parse(result);
      return typeof parsed === "string" ? parsed : parsed.session_id ?? result;
    } catch {
      return result.trim();
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.callTool("close_session", { session_id: sessionId });
  }

  async restartSession(sessionId?: string): Promise<void> {
    const args: Record<string, string> = {};
    if (sessionId) {
      args.session_id = sessionId;
    }
    await this.callTool("restart_session", args);
  }

  async getSessionStatus(sessionId?: string): Promise<string> {
    const args: Record<string, string> = {};
    if (sessionId) {
      args.session_id = sessionId;
    }
    return await this.callTool("get_session_status", args);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    const wasRunning = this._running;
    this._running = false;
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
      this.client = undefined;
    }
    if (this.process) {
      this.process.kill();
      this.process = undefined;
    }
    this.port = undefined;
    this.token = undefined;
    if (wasRunning) {
      this._onDidChangeRunning.fire();
    }
  }

  // ── Private ────────────────────────────────────────────────────────

  private async spawnAndConnect(): Promise<void> {
    this._generation++;
    const args = ["--http", "--port", "0"];

    this.outputChannel.appendLine(
      `Spawning: ${this.mcpPath} ${args.join(" ")}`
    );

    // Track spawn errors (e.g. ENOENT if binary not found)
    let spawnError: Error | undefined;

    this.process = spawn(this.mcpPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.process.on("error", (err) => {
      spawnError = err;
      this.outputChannel.appendLine(`[aximar-mcp spawn error] ${err.message}`);
      this._running = false;
    });

    // Parse the startup JSON line from stdout to get port and token
    const startupInfo = await this.waitForStartupInfo(this.process);

    // Give the process a moment to fail with ENOENT before continuing
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (spawnError) {
      throw new Error(`Failed to spawn aximar-mcp: ${spawnError.message}`);
    }

    this.port = startupInfo.port;
    this.token = startupInfo.token ?? undefined;
    this.outputChannel.appendLine(
      `aximar-mcp started on port ${this.port} (auth: ${this.token ? "yes" : "no"})`
    );

    this.process.stderr?.on("data", (data: Buffer) => {
      this.outputChannel.appendLine(`[aximar-mcp stderr] ${data.toString().trimEnd()}`);
    });
    this.process.on("exit", (code) => {
      this.outputChannel.appendLine(`aximar-mcp exited with code ${code}`);
      this._running = false;
      this._onDidChangeRunning.fire();
    });

    // Wait for HTTP endpoint to become ready
    await this.waitForReady();

    // Connect MCP client
    const url = new URL(`http://localhost:${this.port}/mcp`);
    this.outputChannel.appendLine(`Connecting MCP client to ${url}`);

    const transportOpts: { requestInit?: RequestInit } = {};
    if (this.token) {
      transportOpts.requestInit = {
        headers: { Authorization: `Bearer ${this.token}` },
      };
    }
    const transport = new StreamableHTTPClientTransport(url, transportOpts);
    this.client = new Client(
      { name: "maxima-notebook", version: "0.1.0" },
      { capabilities: {} }
    );

    try {
      await this.client.connect(transport);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`MCP connect failed: ${message}`);
      throw new Error(`Failed to connect to aximar-mcp: ${message}`);
    }

    this._running = true;
    this._onDidChangeRunning.fire();
    this.outputChannel.appendLine("Connected to aximar-mcp via MCP SDK");
  }

  /**
   * Wait for the startup JSON line on stdout.
   * Collects stdout data until a complete JSON object is parsed,
   * then switches remaining stdout output to the output channel.
   */
  private waitForStartupInfo(proc: ChildProcess): Promise<ServerStartupInfo> {
    return new Promise<ServerStartupInfo>((resolve, reject) => {
      let buffer = "";
      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for aximar-mcp startup info"));
      }, SPAWN_TIMEOUT_MS);

      const onData = (data: Buffer) => {
        buffer += data.toString();
        // Look for a complete JSON line
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) {
          return;
        }
        const line = buffer.substring(0, newlineIdx).trim();
        const remainder = buffer.substring(newlineIdx + 1);

        clearTimeout(timeout);
        proc.stdout?.removeListener("data", onData);

        // Log any remainder and future stdout to the output channel
        if (remainder.trim()) {
          this.outputChannel.appendLine(`[aximar-mcp stdout] ${remainder.trimEnd()}`);
        }
        proc.stdout?.on("data", (d: Buffer) => {
          this.outputChannel.appendLine(`[aximar-mcp stdout] ${d.toString().trimEnd()}`);
        });

        try {
          const info = JSON.parse(line) as ServerStartupInfo;
          if (typeof info.port !== "number") {
            reject(new Error(`Invalid startup info: missing port in ${line}`));
            return;
          }
          resolve(info);
        } catch (err) {
          reject(new Error(`Failed to parse aximar-mcp startup info: ${line}`));
        }
      };

      proc.stdout?.on("data", onData);
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      proc.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`aximar-mcp exited with code ${code} before startup info`));
      });
    });
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + SPAWN_TIMEOUT_MS;
    const url = `http://localhost:${this.port}/mcp`;
    const headers: Record<string, string> = {};
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    while (Date.now() < deadline) {
      // Check if process died
      if (this.process && this.process.exitCode !== null) {
        throw new Error(`aximar-mcp exited with code ${this.process.exitCode}`);
      }

      try {
        // A simple fetch to see if the server is listening
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);
        const resp = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        clearTimeout(timeout);
        // Any non-401 response means server is up and auth works
        if (resp.status && resp.status !== 401) {
          return;
        }
        // 401 with a token means something is wrong
        if (resp.status === 401 && this.token) {
          throw new Error("aximar-mcp rejected our auth token");
        }
      } catch (err) {
        // AbortError or ECONNREFUSED — not ready yet
        if (err instanceof Error && err.message.includes("rejected our auth token")) {
          throw err;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(`aximar-mcp did not become ready within ${SPAWN_TIMEOUT_MS}ms`);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureRunning();

    if (!this.client) {
      throw new Error("MCP client not connected");
    }

    this.outputChannel.appendLine(`Calling tool: ${name}`);

    let result;
    try {
      result = await this.client.callTool({ name, arguments: args });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`Tool call ${name} failed: ${message}`);
      throw err;
    }

    // Extract text content from the MCP response
    if (result.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text);
      return textParts.join("");
    }

    return "";
  }
}
