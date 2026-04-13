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
import * as fs from "fs/promises";
import { SourceMapping } from "./sourceMapping";
import type { CellLineMapping } from "./sourceMapping";
import {
  NOTEBOOK_DEBUG_NAMES,
  trackerLog,
  isMaximaNotebook,
  generateTempFile,
} from "./debugHelpers";

// ── Module state ─────────────────────────────────────────────────────

let activeMapping: SourceMapping | undefined;
let sessionTerminationListener: vscode.Disposable | undefined;
let activeNotebookUri: string | undefined;
let activeUpToCellIndex: number | undefined;

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
  private readonly sm: SourceMapping;

  /** Maps request_seq of rewritten setBreakpoints → original cell URI. */
  private pendingBreakpointRequests = new Map<number, string>();

  constructor(sourceMapping: SourceMapping) {
    this.sm = sourceMapping;
  }

  // ── Outgoing: VS Code → adapter ───────────────────────────────────

  onWillReceiveMessage(message: { type: string; command?: string; seq?: number; arguments?: any }): void {
    if (
      message.type === "request" &&
      message.command === "setBreakpoints" &&
      message.arguments?.source?.path
    ) {
      const sourcePath: string = message.arguments.source.path;
      if (this.sm.mappingForCellUri(sourcePath)) {
        // Notebook cell that belongs to the session being debugged — rewrite.
        this.rewriteSetBreakpointsRequest(message);
      } else if (sourcePath.startsWith("vscode-notebook-cell:")) {
        // Notebook cell from a DIFFERENT notebook (or a non-code cell).
        // Clear the breakpoints so maxima-dap doesn't create junk entries
        // that interfere with deferred-breakpoint matching.
        trackerLog(`[setBreakpoints req] suppressing unrelated notebook cell: ${sourcePath}`);
        message.arguments.breakpoints = [];
        message.arguments.lines = [];
      }
    }
  }

  private rewriteSetBreakpointsRequest(message: any): void {
    const sourcePath: string = message.arguments.source.path;

    // Remember the original cell URI so we can reverse-map the response.
    this.pendingBreakpointRequests.set(message.seq, sourcePath);
    trackerLog(`[setBreakpoints req] seq=${message.seq} cell=${sourcePath} → ${this.sm.tempFilePath}`);

    // Rewrite source to the temp file.
    message.arguments.source.path = this.sm.tempFilePath;
    message.arguments.source.name = path.basename(this.sm.tempFilePath);

    // Remap line numbers.
    if (Array.isArray(message.arguments.breakpoints)) {
      for (const bp of message.arguments.breakpoints) {
        if (typeof bp.line === "number") {
          const tempLine = this.sm.cellToTempLine(sourcePath, bp.line);
          if (tempLine !== undefined) {
            bp.line = tempLine;
          }
        }
      }
    }
    if (Array.isArray(message.arguments.lines)) {
      message.arguments.lines = message.arguments.lines.map(
        (l: number) => this.sm.cellToTempLine(sourcePath, l) ?? l,
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
      trackerLog(`[setBreakpoints resp] request_seq=${message.request_seq} — not a notebook request`);
      return; // Not a notebook-cell breakpoint we remapped.
    }
    this.pendingBreakpointRequests.delete(message.request_seq);

    const mapping = this.sm.mappingForCellUri(cellUri);
    if (!mapping) {
      trackerLog(`[setBreakpoints resp] no mapping for cellUri=${cellUri}`);
      return;
    }

    const breakpoints: DapBreakpoint[] | undefined =
      message.body?.breakpoints;
    if (!breakpoints) {
      trackerLog(`[setBreakpoints resp] no breakpoints in body`);
      return;
    }

    for (const bp of breakpoints) {
      trackerLog(
        `[setBreakpoints resp] bp id=${bp.id} verified=${bp.verified} ` +
        `line=${bp.line} source=${bp.source?.path} message=${bp.message ?? "(none)"}`,
      );
      if (bp.source && this.sm.isTempFile(bp.source.path ?? "")) {
        bp.source.path = cellUri;
        bp.source.name = this.sm.cellDisplayName(mapping.cellIndex);
      }
      if (typeof bp.line === "number") {
        const loc = this.sm.tempToCellLocation(bp.line);
        if (loc) {
          bp.line = loc.cellLine;
        }
        // Track breakpoint ID → cell mapping and cell-relative line for
        // future breakpoint events.
        if (typeof bp.id === "number") {
          this.sm.trackBreakpointId(bp.id, mapping, bp.line);
          trackerLog(`[setBreakpoints resp]   tracked id=${bp.id} → cell ${mapping.cellIndex}`);
        }
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
      if (frame.source && this.sm.isTempFile(frame.source.path ?? "")) {
        const loc = this.sm.tempToCellLocation(frame.line);
        if (loc) {
          frame.source.path = loc.cellUri;
          frame.source.name = this.sm.cellDisplayName(loc.cellIndex);
          frame.line = loc.cellLine;
        }
      }
    }
  }

  private rewriteBreakpointEvent(message: any): void {
    const bp: DapBreakpoint | undefined = message.body?.breakpoint;
    if (!bp) {
      return;
    }

    trackerLog(
      `[breakpoint event] id=${bp.id} verified=${bp.verified} ` +
      `line=${bp.line} source=${bp.source?.path} ` +
      `tempFile=${this.sm.tempFilePath}`,
    );

    // Primary: look up by breakpoint ID (reliable even when line is snapped
    // or the source path has been normalised differently by the adapter).
    const idMapping = typeof bp.id === "number"
      ? this.sm.breakpointMapping(bp.id)
      : undefined;

    // Fallback: match by temp-file source path + line number.
    const lineMapping =
      !idMapping &&
      this.sm.isTempFile(bp.source?.path ?? "") &&
      typeof bp.line === "number"
        ? this.sm.mappingForTempLine(bp.line)
        : undefined;

    const mapping = idMapping ?? lineMapping;
    if (!mapping) {
      trackerLog(`[breakpoint event] NO MAPPING for bp id=${bp.id}`);
      return;
    }

    if (!bp.source) {
      bp.source = {} as DapSource;
    }
    bp.source.path = mapping.cellUri;
    bp.source.name = this.sm.cellDisplayName(mapping.cellIndex);
    // Use the cell line we stored from the setBreakpoints response — it
    // already has the correct cell-relative position (including any
    // snapping that was reported at set time).
    if (typeof bp.id === "number") {
      const cellLine = this.sm.breakpointCellLine(bp.id);
      if (cellLine !== undefined) {
        bp.line = cellLine;
      }
    }
    trackerLog(
      `[breakpoint event] rewriting → cell ${mapping.cellIndex} line ${bp.line} ` +
      `(matched by ${idMapping ? "id" : "line"})`,
    );
  }
}

// ── Breakpoint migration (save / rename) ─────────────────────────────

/**
 * Extract the notebook portion from a vscode-notebook-cell URI (strip fragment).
 * e.g. "vscode-notebook-cell:Untitled-1.macnb?maxima-notebook#frag" →
 *      "vscode-notebook-cell:Untitled-1.macnb?maxima-notebook"
 */
function cellUriNotebookPart(cellUri: string): string {
  const hashIdx = cellUri.indexOf("#");
  return hashIdx >= 0 ? cellUri.substring(0, hashIdx) : cellUri;
}


/**
 * Migrate orphaned breakpoints at debug launch time.
 *
 * When a notebook's URI changes (e.g. untitled → file save), existing
 * breakpoints still reference the old cell URIs. This function finds
 * vscode-notebook-cell breakpoints that don't belong to any currently-open
 * notebook and migrates them to the notebook being debugged.
 *
 * To avoid migrating breakpoints from OTHER closed notebooks, we only
 * migrate orphaned cell URIs whose notebook-part prefix doesn't match
 * any open notebook's cell URIs.
 */
function migrateOrphanedBreakpoints(
  notebook: vscode.NotebookDocument,
): void {
  // Current cell URIs for the notebook being debugged
  const currentCellUris = new Set<string>();
  for (let i = 0; i < notebook.cellCount; i++) {
    currentCellUris.add(notebook.cellAt(i).document.uri.toString());
  }

  // If any breakpoints already match the current cell URIs, the notebook
  // hasn't changed URI — no migration needed.
  for (const bp of vscode.debug.breakpoints) {
    if (
      bp instanceof vscode.SourceBreakpoint &&
      currentCellUris.has(bp.location.uri.toString())
    ) {
      return;
    }
  }

  // Collect all cell URI notebook-parts from ALL open notebooks
  const openNotebookCellPrefixes = new Set<string>();
  for (const doc of vscode.workspace.notebookDocuments) {
    for (let i = 0; i < doc.cellCount; i++) {
      openNotebookCellPrefixes.add(
        cellUriNotebookPart(doc.cellAt(i).document.uri.toString()),
      );
    }
  }

  // Find orphaned notebook-cell breakpoints: their notebook-part doesn't
  // match any open notebook.
  const orphanedByCellUri = new Map<string, vscode.SourceBreakpoint[]>();
  const orphanedCellUrisInOrder: string[] = [];

  for (const bp of vscode.debug.breakpoints) {
    if (!(bp instanceof vscode.SourceBreakpoint)) {
      continue;
    }
    const uri = bp.location.uri.toString();
    if (!uri.startsWith("vscode-notebook-cell:")) {
      continue;
    }
    if (currentCellUris.has(uri)) {
      continue; // Already matches the current notebook — no migration needed
    }
    const nbPart = cellUriNotebookPart(uri);
    if (openNotebookCellPrefixes.has(nbPart)) {
      continue; // Belongs to another open notebook — don't touch
    }
    if (!orphanedByCellUri.has(uri)) {
      orphanedByCellUri.set(uri, []);
      orphanedCellUrisInOrder.push(uri);
    }
    orphanedByCellUri.get(uri)!.push(bp);
  }

  if (orphanedCellUrisInOrder.length === 0) {
    return;
  }

  // Group orphaned cell URIs by their notebook-part prefix so we can
  // handle each closed notebook separately.
  const groups = new Map<string, string[]>();
  for (const cellUri of orphanedCellUrisInOrder) {
    const nbPart = cellUriNotebookPart(cellUri);
    if (!groups.has(nbPart)) {
      groups.set(nbPart, []);
    }
    groups.get(nbPart)!.push(cellUri);
  }

  // Only migrate breakpoints from untitled notebooks (untitled → file save).
  // Untitled cell URI prefix: "vscode-notebook-cell:Name.macnb?type"
  // (no leading "/" after the scheme).  File-backed breakpoints from other
  // closed notebooks are left alone.
  let matchedPrefix: string | undefined;

  for (const prefix of groups.keys()) {
    const afterScheme = prefix.substring("vscode-notebook-cell:".length);
    if (!afterScheme.startsWith("/")) {
      matchedPrefix = prefix;
      break;
    }
  }

  if (!matchedPrefix) {
    return;
  }

  const groupCellUris = groups.get(matchedPrefix)!;
  trackerLog(
    `[migrateOrphanedBreakpoints] migrating ${groupCellUris.length} orphaned cell URIs from ${matchedPrefix}`,
  );

  // Build new cell URI list (all cells in document order)
  const newCellUris: string[] = [];
  for (let i = 0; i < notebook.cellCount; i++) {
    newCellUris.push(notebook.cellAt(i).document.uri.toString());
  }

  const oldBreakpoints: vscode.SourceBreakpoint[] = [];
  const newBreakpoints: vscode.SourceBreakpoint[] = [];

  for (let idx = 0; idx < groupCellUris.length; idx++) {
    const oldCellUri = groupCellUris[idx];
    const bps = orphanedByCellUri.get(oldCellUri)!;

    if (idx >= newCellUris.length) {
      trackerLog(
        `[migrateOrphanedBreakpoints] cell index ${idx} exceeds new cell count ${newCellUris.length}`,
      );
      continue;
    }
    const newCellUri = newCellUris[idx];

    for (const bp of bps) {
      oldBreakpoints.push(bp);
      newBreakpoints.push(
        new vscode.SourceBreakpoint(
          new vscode.Location(vscode.Uri.parse(newCellUri), bp.location.range),
          bp.enabled,
          bp.condition,
          bp.hitCondition,
          bp.logMessage,
        ),
      );
      trackerLog(
        `[migrateOrphanedBreakpoints] ${oldCellUri} → ${newCellUri} line ${bp.location.range.start.line + 1}`,
      );
    }
  }

  if (oldBreakpoints.length > 0) {
    vscode.debug.removeBreakpoints(oldBreakpoints);
    vscode.debug.addBreakpoints(newBreakpoints);
    trackerLog(
      `[migrateOrphanedBreakpoints] migrated ${newBreakpoints.length} breakpoints`,
    );
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────

/** Clear session listener, preserving temp file and state for restart. */
function onSessionTerminated(): void {
  if (sessionTerminationListener) {
    sessionTerminationListener.dispose();
    sessionTerminationListener = undefined;
  }
}

/** Full cleanup: delete temp file and clear all state. */
async function cleanupFull(): Promise<void> {
  if (activeMapping) {
    try {
      await fs.unlink(activeMapping.tempFilePath);
    } catch {
      // Ignore — file may already be gone
    }
    activeMapping = undefined;
  }
  activeNotebookUri = undefined;
  activeUpToCellIndex = undefined;
  onSessionTerminated();
}

/** Regenerate the temp file from the active notebook (e.g. on restart). */
async function regenerateTempFile(): Promise<void> {
  if (!activeNotebookUri) {
    return;
  }

  const notebook = vscode.workspace.notebookDocuments.find(
    (doc) => doc.uri.toString() === activeNotebookUri,
  );
  if (!notebook) {
    trackerLog(`[restart] notebook not found: ${activeNotebookUri}`);
    return;
  }

  try {
    const { tempFilePath, mappings } = await generateTempFile(
      notebook,
      activeUpToCellIndex,
    );
    let resolvedPath = tempFilePath;
    try {
      resolvedPath = await fs.realpath(tempFilePath);
    } catch {
      // keep original
    }
    activeMapping = new SourceMapping(resolvedPath, mappings);
    trackerLog(`[restart] regenerated temp file: ${resolvedPath}`);
  } catch (err) {
    trackerLog(`[restart] failed to regenerate: ${err}`);
  }
}

// ── Launch helper ────────────────────────────────────────────────────

async function launchDebugSession(
  notebook: vscode.NotebookDocument,
  sessionName: string,
  upToCellIndex?: number,
): Promise<void> {
  // If there's stale state from a previous session, check if it's still running.
  if (activeMapping) {
    const activeSession = vscode.debug.activeDebugSession;
    if (
      activeSession?.type === "maxima" &&
      NOTEBOOK_DEBUG_NAMES.includes(activeSession.name)
    ) {
      vscode.window.showWarningMessage(
        "A notebook debug session is already active. Stop it before starting a new one.",
      );
      return;
    }
    // Previous session ended — clean up stale state before fresh launch.
    await cleanupFull();
  }

  // Save untitled notebooks before debugging so that cell URIs are stable
  // and breakpoints can be correctly mapped.  VS Code would auto-save during
  // startDebugging anyway, but doing it first lets us capture the final
  // cell URIs in the temp file and migrate breakpoints proactively.
  let doc = notebook;
  if (doc.isUntitled) {
    const savedUri = await vscode.workspace.save(doc.uri);
    if (!savedUri) {
      return; // User cancelled the save dialog
    }
    // The save may replace the document object (untitled → file).
    // Find the new document by URI.
    const savedDoc = vscode.workspace.notebookDocuments.find(
      (d) => d.uri.toString() === savedUri.toString(),
    );
    if (!savedDoc) {
      vscode.window.showErrorMessage("Could not find saved notebook.");
      return;
    }
    doc = savedDoc;
    // Migrate breakpoints from old untitled cell URIs to new file cell URIs
    migrateOrphanedBreakpoints(doc);
  }

  let tempFilePath: string;
  let mappings: CellLineMapping[];
  try {
    ({ tempFilePath, mappings } = await generateTempFile(
      doc,
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

  activeMapping = new SourceMapping(tempFilePath, mappings);
  activeNotebookUri = doc.uri.toString();
  activeUpToCellIndex = upToCellIndex;

  sessionTerminationListener = vscode.debug.onDidTerminateDebugSession(
    (session) => {
      if (
        session.type === "maxima" &&
        NOTEBOOK_DEBUG_NAMES.includes(session.name)
      ) {
        onSessionTerminated();
      }
    },
  );

  // Set cwd to the notebook's directory so relative load()/batchload()
  // paths in user code resolve correctly.
  const notebookDir = path.dirname(doc.uri.fsPath);

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
    await cleanupFull();
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
  const trackerFactory = vscode.debug.registerDebugAdapterTrackerFactory("maxima", {
    createDebugAdapterTracker(session) {
      // Only attach the remapping tracker for notebook debug sessions.
      if (activeMapping && NOTEBOOK_DEBUG_NAMES.includes(session.name)) {
        return new NotebookDebugAdapterTracker(activeMapping);
      }
      return undefined;
    },
  });

  // On session start, handle restart: regenerate the temp file from the
  // notebook (in case cells were edited) and re-register the termination
  // listener for the new session.
  const startListener = vscode.debug.onDidStartDebugSession(async (session) => {
    if (
      session.type === "maxima" &&
      NOTEBOOK_DEBUG_NAMES.includes(session.name) &&
      activeNotebookUri &&
      activeMapping &&
      !sessionTerminationListener // No listener → previous session ended, this is a restart
    ) {
      trackerLog("[restart] detected restart, regenerating temp file");
      await regenerateTempFile();

      sessionTerminationListener = vscode.debug.onDidTerminateDebugSession(
        (terminated) => {
          if (
            terminated.type === "maxima" &&
            NOTEBOOK_DEBUG_NAMES.includes(terminated.name)
          ) {
            onSessionTerminated();
          }
        },
      );
    }
  });

  return vscode.Disposable.from(trackerFactory, startListener);
}

