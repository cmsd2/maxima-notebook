/**
 * Notebook debugging: DAP adapter tracker and registration.
 *
 * A DebugAdapterTracker intercepts DAP messages to remap source locations
 * between notebook cell URIs and the temp file, so breakpoints and stack
 * frames appear inline in notebook cells rather than in the temp file.
 */

import * as vscode from "vscode";
import * as path from "path";
import { SourceMapping } from "./sourceMapping";
import type {
  DapSource,
  DapBreakpoint,
  DapStackFrame,
} from "./sourceMapping";
import {
  NOTEBOOK_DEBUG_NAMES,
  trackerLog,
} from "./helpers";
import { getActiveSession } from "./session";

// ── Debug adapter tracker ────────────────────────────────────────────

/**
 * Intercepts DAP messages to remap source locations between notebook
 * cell URIs and the temp .mac file.
 *
 * Outgoing (VS Code -> adapter):
 *   setBreakpoints for a notebook cell -> rewrite source to temp file
 *
 * Incoming (adapter -> VS Code):
 *   setBreakpoints response -> rewrite back to cell URIs
 *   stackTrace response     -> rewrite frame sources to cell URIs
 *   breakpoint event        -> rewrite to cell URI
 */
class NotebookDebugAdapterTracker implements vscode.DebugAdapterTracker {
  private readonly sm: SourceMapping;

  /** Maps request_seq of rewritten setBreakpoints -> original cell URI. */
  private pendingBreakpointRequests = new Map<number, string>();

  constructor(sourceMapping: SourceMapping) {
    this.sm = sourceMapping;
  }

  // ── Outgoing: VS Code -> adapter ───────────────────────────────────

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

  // ── Incoming: adapter -> VS Code ───────────────────────────────────

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
        // Track breakpoint ID -> cell mapping and cell-relative line for
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

// ── Tracker factory registration ─────────────────────────────────────

export function registerDebugAdapterTracker(): vscode.Disposable {
  const trackerFactory = vscode.debug.registerDebugAdapterTrackerFactory("maxima", {
    createDebugAdapterTracker(session) {
      const activeSession = getActiveSession();
      // Only attach the remapping tracker for notebook debug sessions.
      if (activeSession && NOTEBOOK_DEBUG_NAMES.includes(session.name)) {
        return new NotebookDebugAdapterTracker(activeSession.mapping);
      }
      return undefined;
    },
  });

  // On session start, handle restart: regenerate the temp file from the
  // notebook (in case cells were edited) and re-register the termination
  // listener for the new session.
  const startListener = vscode.debug.onDidStartDebugSession(async (session) => {
    const activeSession = getActiveSession();
    if (
      session.type === "maxima" &&
      NOTEBOOK_DEBUG_NAMES.includes(session.name) &&
      activeSession &&
      !activeSession.isWatchingTermination // No listener → previous session ended, this is a restart
    ) {
      trackerLog("[restart] detected restart, regenerating temp file");
      await activeSession.regenerate();
      activeSession.watchTermination();
    }
  });

  return vscode.Disposable.from(trackerFactory, startListener);
}
