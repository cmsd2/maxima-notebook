/**
 * Notebook debugging: write cells to a temp .mac file and launch maxima-dap.
 *
 * A DebugAdapterTracker intercepts DAP messages to remap source locations
 * between notebook cell URIs and the temp file, so breakpoints and stack
 * frames appear inline in notebook cells rather than in the temp file.
 *
 * Also provides AI debug tools (LM tools) for inspecting debug sessions.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { NOTEBOOK_TYPE, NOTEBOOK_TYPE_COMPAT } from "./controller";

// ── Constants ────────────────────────────────────────────────────────

const MAXIMA_NOTEBOOK_TYPES = [NOTEBOOK_TYPE, NOTEBOOK_TYPE_COMPAT];
const TEMP_FILE_PREFIX = "__maxima_notebook_debug_";
const TEMP_FILE_EXT = ".mac";
const NOTEBOOK_DEBUG_NAMES = ["Debug Notebook", "Debug From Cell"];

// ── Types ────────────────────────────────────────────────────────────

interface CellLineMapping {
  cellIndex: number;
  cellUri: string;
  startLine: number; // 1-based line in temp file where cell code begins
  lineCount: number;
}

// ── Module state ─────────────────────────────────────────────────────

let activeTempFile: string | undefined;
let activeCellMappings: CellLineMapping[] | undefined;
let sessionTerminationListener: vscode.Disposable | undefined;

// ── Helpers ──────────────────────────────────────────────────────────

function isMaximaNotebook(notebook: vscode.NotebookDocument): boolean {
  return MAXIMA_NOTEBOOK_TYPES.includes(notebook.notebookType);
}

function getTempFileName(notebook: vscode.NotebookDocument): string {
  let baseName: string;
  if (notebook.isUntitled) {
    baseName = "untitled";
  } else {
    baseName = path
      .basename(notebook.uri.fsPath)
      .replace(/[^a-zA-Z0-9]/g, "_");
  }
  return `${TEMP_FILE_PREFIX}${baseName}${TEMP_FILE_EXT}`;
}

function textResult(value: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(value),
  ]);
}

function getActiveMaximaDebugSession(): vscode.DebugSession | undefined {
  const session = vscode.debug.activeDebugSession;
  if (session && session.type === "maxima") {
    return session;
  }
  return undefined;
}

// ── Temp file generation ─────────────────────────────────────────────

async function generateTempFile(
  notebook: vscode.NotebookDocument,
  upToCellIndex?: number,
): Promise<{ tempFilePath: string; mappings: CellLineMapping[] }> {
  const lastIndex = upToCellIndex ?? notebook.cellCount - 1;
  const codeCells: {
    cellIndex: number;
    cellUri: string;
    source: string;
  }[] = [];

  for (let i = 0; i <= lastIndex && i < notebook.cellCount; i++) {
    const cell = notebook.cellAt(i);
    if (cell.kind === vscode.NotebookCellKind.Code) {
      codeCells.push({
        cellIndex: i,
        cellUri: cell.document.uri.toString(),
        source: cell.document.getText(),
      });
    }
  }

  if (codeCells.length === 0) {
    throw new Error("No code cells found in the notebook.");
  }

  const notebookName = notebook.isUntitled
    ? "Untitled"
    : path.basename(notebook.uri.fsPath);

  const lines: string[] = [];
  lines.push("/* === Maxima Notebook Debug === */");
  lines.push(`/* Generated from: ${notebookName} */`);
  lines.push("");

  const mappings: CellLineMapping[] = [];

  for (const { cellIndex, cellUri, source } of codeCells) {
    const commentLine = lines.length + 1;
    lines.push(`/* Cell ${cellIndex + 1} (line ${commentLine}) */`);

    const startLine = lines.length + 1;
    const sourceLines = source.split("\n");
    if (
      sourceLines.length > 1 &&
      sourceLines[sourceLines.length - 1] === ""
    ) {
      sourceLines.pop();
    }
    for (const line of sourceLines) {
      lines.push(line);
    }
    lines.push("");

    mappings.push({
      cellIndex,
      cellUri,
      startLine,
      lineCount: sourceLines.length,
    });
  }

  const tempFilePath = path.join(os.tmpdir(), getTempFileName(notebook));
  await fs.writeFile(tempFilePath, lines.join("\n"), "utf-8");

  return { tempFilePath, mappings };
}

// ── Source mapping ───────────────────────────────────────────────────

/** Find the mapping entry for a given notebook cell URI. */
function mappingForCellUri(
  cellUri: string,
): CellLineMapping | undefined {
  return activeCellMappings?.find((m) => m.cellUri === cellUri);
}

/** Find the mapping entry that contains a given temp-file line.
 *  Falls back to the nearest cell if the line is between cells
 *  (e.g. on a comment or separator line). */
function mappingForTempLine(
  tempLine: number,
): CellLineMapping | undefined {
  if (!activeCellMappings || activeCellMappings.length === 0) {
    return undefined;
  }
  // Exact match: line falls within a cell's range.
  for (let i = activeCellMappings.length - 1; i >= 0; i--) {
    const m = activeCellMappings[i];
    if (tempLine >= m.startLine && tempLine < m.startLine + m.lineCount) {
      return m;
    }
  }
  // Nearest: find the closest cell (handles comment/separator lines).
  let best: CellLineMapping | undefined;
  let bestDist = Infinity;
  for (const m of activeCellMappings) {
    const cellEnd = m.startLine + m.lineCount - 1;
    const dist = tempLine < m.startLine
      ? m.startLine - tempLine
      : tempLine - cellEnd;
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  return best;
}

/** Convert a temp-file line number to a cell-relative line number. */
function tempLineToCell(
  mapping: CellLineMapping,
  tempLine: number,
): number {
  return tempLine - mapping.startLine + 1; // 1-based within cell
}

/** Convert a cell-relative line number to a temp-file line number. */
function cellLineToTemp(
  mapping: CellLineMapping,
  cellLine: number,
): number {
  return cellLine - 1 + mapping.startLine; // 1-based in temp file
}

// ── DAP message types (minimal shapes) ──────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

interface DapSource {
  name?: string;
  path?: string;
  sourceReference?: number;
  [key: string]: any;
}

interface DapBreakpoint {
  id?: number;
  verified?: boolean;
  message?: string;
  source?: DapSource;
  line?: number;
  [key: string]: any;
}

interface DapStackFrame {
  id: number;
  name: string;
  source?: DapSource;
  line: number;
  column: number;
  [key: string]: any;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Debug adapter tracker ────────────────────────────────────────────

/**
 * Intercepts DAP messages to remap source locations between notebook
 * cell URIs and the temp .mac file.
 *
 * Outgoing (VS Code → adapter):
 *   setBreakpoints for a notebook cell → rewrite source to temp file
 *
 * Incoming (adapter → VS Code):
 *   setBreakpoints response → rewrite back to cell URIs
 *   stackTrace response     → rewrite frame sources to cell URIs
 *   breakpoint event        → rewrite to cell URI
 */
class NotebookDebugAdapterTracker implements vscode.DebugAdapterTracker {
  /** Maps request_seq of rewritten setBreakpoints → original cell URI. */
  private pendingBreakpointRequests = new Map<number, string>();

  /** Maps DAP breakpoint ID → cell mapping, so breakpoint-changed events
   *  can always be rewritten even when the line has been snapped. */
  private breakpointIdToMapping = new Map<number, CellLineMapping>();

  // ── Outgoing: VS Code → adapter ───────────────────────────────────

  onWillReceiveMessage(message: { type: string; command?: string; seq?: number; arguments?: any }): void {
    if (
      message.type === "request" &&
      message.command === "setBreakpoints" &&
      message.arguments?.source?.path
    ) {
      this.rewriteSetBreakpointsRequest(message);
    }
  }

  private rewriteSetBreakpointsRequest(message: any): void {
    const sourcePath: string = message.arguments.source.path;
    const mapping = mappingForCellUri(sourcePath);
    if (!mapping || !activeTempFile) {
      return;
    }

    // Remember the original cell URI so we can reverse-map the response.
    this.pendingBreakpointRequests.set(message.seq, sourcePath);

    // Rewrite source to the temp file.
    message.arguments.source.path = activeTempFile;
    message.arguments.source.name = path.basename(activeTempFile);

    // Remap line numbers.
    if (Array.isArray(message.arguments.breakpoints)) {
      for (const bp of message.arguments.breakpoints) {
        if (typeof bp.line === "number") {
          bp.line = cellLineToTemp(mapping, bp.line);
        }
      }
    }
    if (Array.isArray(message.arguments.lines)) {
      message.arguments.lines = message.arguments.lines.map(
        (l: number) => cellLineToTemp(mapping, l),
      );
    }
  }

  // ── Incoming: adapter → VS Code ───────────────────────────────────

  onDidSendMessage(message: { type: string; command?: string; request_seq?: number; event?: string; body?: any }): void {
    if (message.type === "response" && message.command === "setBreakpoints") {
      this.rewriteSetBreakpointsResponse(message);
    } else if (
      message.type === "response" &&
      message.command === "stackTrace"
    ) {
      this.rewriteStackTraceResponse(message);
    } else if (message.type === "event" && message.event === "breakpoint") {
      this.rewriteBreakpointEvent(message);
    }
  }

  private rewriteSetBreakpointsResponse(message: any): void {
    const cellUri = this.pendingBreakpointRequests.get(message.request_seq);
    if (!cellUri) {
      return; // Not a notebook-cell breakpoint we remapped.
    }
    this.pendingBreakpointRequests.delete(message.request_seq);

    const mapping = mappingForCellUri(cellUri);
    if (!mapping) {
      return;
    }

    const breakpoints: DapBreakpoint[] | undefined =
      message.body?.breakpoints;
    if (!breakpoints) {
      return;
    }

    for (const bp of breakpoints) {
      // Track breakpoint ID → cell mapping for future breakpoint events.
      if (typeof bp.id === "number") {
        this.breakpointIdToMapping.set(bp.id, mapping);
      }
      if (bp.source && bp.source.path === activeTempFile) {
        bp.source.path = cellUri;
        bp.source.name = `Cell ${mapping.cellIndex + 1}`;
      }
      if (typeof bp.line === "number") {
        bp.line = tempLineToCell(mapping, bp.line);
      }
    }
  }

  private rewriteStackTraceResponse(message: any): void {
    const frames: DapStackFrame[] | undefined =
      message.body?.stackFrames;
    if (!frames) {
      return;
    }

    for (const frame of frames) {
      if (frame.source && frame.source.path === activeTempFile) {
        const mapping = mappingForTempLine(frame.line);
        if (mapping) {
          frame.source.path = mapping.cellUri;
          frame.source.name = `Cell ${mapping.cellIndex + 1}`;
          frame.line = tempLineToCell(mapping, frame.line);
        }
      }
    }
  }

  private rewriteBreakpointEvent(message: any): void {
    const bp: DapBreakpoint | undefined = message.body?.breakpoint;
    if (!bp || bp.source?.path !== activeTempFile) {
      return;
    }

    // Primary: look up by breakpoint ID (reliable even when line is snapped).
    const idMapping = typeof bp.id === "number"
      ? this.breakpointIdToMapping.get(bp.id)
      : undefined;

    // Fallback: look up by temp-file line number.
    const lineMapping = typeof bp.line === "number"
      ? mappingForTempLine(bp.line)
      : undefined;

    const mapping = idMapping ?? lineMapping;
    if (mapping) {
      bp.source!.path = mapping.cellUri;
      bp.source!.name = `Cell ${mapping.cellIndex + 1}`;
      if (typeof bp.line === "number") {
        bp.line = tempLineToCell(mapping, bp.line);
      }
    }
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────

async function cleanupTempFile(): Promise<void> {
  if (activeTempFile) {
    try {
      await fs.unlink(activeTempFile);
    } catch {
      // Ignore — file may already be gone
    }
    activeTempFile = undefined;
    activeCellMappings = undefined;
  }
  if (sessionTerminationListener) {
    sessionTerminationListener.dispose();
    sessionTerminationListener = undefined;
  }
}

// ── Launch helper ────────────────────────────────────────────────────

async function launchDebugSession(
  notebook: vscode.NotebookDocument,
  sessionName: string,
  upToCellIndex?: number,
): Promise<void> {
  if (activeTempFile) {
    vscode.window.showWarningMessage(
      "A notebook debug session is already active. Stop it before starting a new one.",
    );
    return;
  }

  let tempFilePath: string;
  let mappings: CellLineMapping[];
  try {
    ({ tempFilePath, mappings } = await generateTempFile(
      notebook,
      upToCellIndex,
    ));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(message);
    return;
  }

  // Resolve to the real path so it matches Maxima's canonical output
  // (e.g. macOS /var → /private/var symlink resolution).
  try {
    tempFilePath = await fs.realpath(tempFilePath);
  } catch {
    // If realpath fails, keep the original path.
  }

  activeTempFile = tempFilePath;
  activeCellMappings = mappings;

  sessionTerminationListener = vscode.debug.onDidTerminateDebugSession(
    async (session) => {
      if (
        session.type === "maxima" &&
        NOTEBOOK_DEBUG_NAMES.includes(session.name)
      ) {
        await cleanupTempFile();
      }
    },
  );

  // Set cwd to the notebook's directory so relative load()/batchload()
  // paths in user code resolve correctly.
  const notebookDir = notebook.isUntitled
    ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    : path.dirname(notebook.uri.fsPath);

  const config: vscode.DebugConfiguration = {
    type: "maxima",
    request: "launch",
    name: sessionName,
    program: tempFilePath,
    stopOnEntry: false,
    ...(notebookDir ? { cwd: notebookDir } : {}),
  };

  const folder = vscode.workspace.workspaceFolders?.[0];
  const started = await vscode.debug.startDebugging(folder, config);
  if (!started) {
    await cleanupTempFile();
    vscode.window.showErrorMessage("Failed to start the debug session.");
  }
}

// ── Command: Debug Notebook ──────────────────────────────────────────

export async function debugNotebook(): Promise<void> {
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  if (!notebook || !isMaximaNotebook(notebook)) {
    vscode.window.showWarningMessage("No active Maxima notebook.");
    return;
  }

  await launchDebugSession(notebook, "Debug Notebook");
}

// ── Command: Debug From Cell ─────────────────────────────────────────

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

// ── Tracker factory registration ─────────────────────────────────────

export function registerDebugAdapterTracker(): vscode.Disposable {
  return vscode.debug.registerDebugAdapterTrackerFactory("maxima", {
    createDebugAdapterTracker(session) {
      // Only attach the remapping tracker for notebook debug sessions.
      if (activeTempFile && NOTEBOOK_DEBUG_NAMES.includes(session.name)) {
        return new NotebookDebugAdapterTracker();
      }
      return undefined;
    },
  });
}

// ── AI Debug Tools ───────────────────────────────────────────────────

// Input types

interface DebugEvaluateInput {
  expression: string;
}

// Tool: maxima_debug_variables

class DebugVariablesTool implements vscode.LanguageModelTool<object> {
  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<object>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const session = getActiveMaximaDebugSession();
    if (!session) {
      return textResult("No active Maxima debug session.");
    }

    try {
      const stack = await session.customRequest("stackTrace", {
        threadId: 1,
      });

      if (!stack.stackFrames || stack.stackFrames.length === 0) {
        return textResult(
          "No stack frames available. The program may not be paused at a breakpoint.",
        );
      }

      const topFrame = stack.stackFrames[0];
      const scopesResponse = await session.customRequest("scopes", {
        frameId: topFrame.id,
      });

      const results: Array<{
        scope: string;
        variables: Array<{ name: string; value: string; type?: string }>;
      }> = [];

      for (const scope of scopesResponse.scopes) {
        const varsResponse = await session.customRequest("variables", {
          variablesReference: scope.variablesReference,
        });
        results.push({
          scope: scope.name,
          variables: varsResponse.variables.map(
            (v: { name: string; value: string; type?: string }) => ({
              name: v.name,
              value: v.value,
              type: v.type,
            }),
          ),
        });
      }

      return textResult(JSON.stringify(results, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`Failed to get variables: ${message}`);
    }
  }

  prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<object>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return { invocationMessage: "Reading debug variables\u2026" };
  }
}

// Tool: maxima_debug_evaluate

class DebugEvaluateTool
  implements vscode.LanguageModelTool<DebugEvaluateInput>
{
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DebugEvaluateInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const session = getActiveMaximaDebugSession();
    if (!session) {
      return textResult("No active Maxima debug session.");
    }

    try {
      const stack = await session.customRequest("stackTrace", {
        threadId: 1,
      });

      if (!stack.stackFrames || stack.stackFrames.length === 0) {
        return textResult(
          "No stack frames available. The program may not be paused at a breakpoint.",
        );
      }

      const topFrame = stack.stackFrames[0];
      const result = await session.customRequest("evaluate", {
        expression: options.input.expression,
        context: "repl",
        frameId: topFrame.id,
      });

      return textResult(result.result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`Evaluation failed: ${message}`);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<DebugEvaluateInput>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Evaluating: ${options.input.expression}`,
    };
  }
}

// Tool: maxima_debug_callstack

class DebugCallstackTool implements vscode.LanguageModelTool<object> {
  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<object>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const session = getActiveMaximaDebugSession();
    if (!session) {
      return textResult("No active Maxima debug session.");
    }

    try {
      const stack = await session.customRequest("stackTrace", {
        threadId: 1,
      });

      if (!stack.stackFrames || stack.stackFrames.length === 0) {
        return textResult("No stack frames available.");
      }

      const frames = stack.stackFrames.map(
        (f: { name: string; source?: { path?: string }; line: number }) => ({
          name: f.name,
          source: f.source?.path ?? null,
          line: f.line,
        }),
      );

      return textResult(JSON.stringify(frames, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`Failed to get call stack: ${message}`);
    }
  }

  prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<object>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return { invocationMessage: "Reading debug call stack\u2026" };
  }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerDebugLmTools(): vscode.Disposable[] {
  return [
    vscode.lm.registerTool(
      "maxima_debug_variables",
      new DebugVariablesTool(),
    ),
    vscode.lm.registerTool(
      "maxima_debug_evaluate",
      new DebugEvaluateTool(),
    ),
    vscode.lm.registerTool(
      "maxima_debug_callstack",
      new DebugCallstackTool(),
    ),
  ];
}
