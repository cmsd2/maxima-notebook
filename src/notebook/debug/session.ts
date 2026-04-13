/**
 * Debug session state and launch logic for notebook debugging.
 *
 * Manages the lifecycle of a notebook debug session: creating the temp
 * file, tracking session state, handling restarts, and cleanup.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import type { CellLineMapping } from "./sourceMapping";
import { SourceMapping } from "./sourceMapping";
import {
  NOTEBOOK_DEBUG_NAMES,
  trackerLog,
  generateTempFile,
  resolveAndCreateMapping,
} from "./helpers";
import { migrateOrphanedBreakpoints } from "./migration";

// ── Session state ────────────────────────────────────────────────────

export class DebugSessionState {
  mapping: SourceMapping;
  readonly notebookUri: string;
  readonly upToCellIndex: number | undefined;
  private terminationListener: vscode.Disposable | undefined;

  constructor(
    mapping: SourceMapping,
    notebookUri: string,
    upToCellIndex?: number,
  ) {
    this.mapping = mapping;
    this.notebookUri = notebookUri;
    this.upToCellIndex = upToCellIndex;
  }

  /** Register a listener that clears terminationListener when the session ends. */
  watchTermination(): void {
    this.terminationListener = vscode.debug.onDidTerminateDebugSession(
      (session) => {
        if (
          session.type === "maxima" &&
          NOTEBOOK_DEBUG_NAMES.includes(session.name)
        ) {
          this.onTerminated();
        }
      },
    );
  }

  /** Clear the termination listener (session ended, ready for restart). */
  onTerminated(): void {
    if (this.terminationListener) {
      this.terminationListener.dispose();
      this.terminationListener = undefined;
    }
  }

  /** Whether the termination listener is active (session still running or not yet restarted). */
  get isWatchingTermination(): boolean {
    return this.terminationListener !== undefined;
  }

  /** Regenerate mapping from the notebook (for restart). */
  async regenerate(): Promise<void> {
    const notebook = vscode.workspace.notebookDocuments.find(
      (doc) => doc.uri.toString() === this.notebookUri,
    );
    if (!notebook) {
      trackerLog(`[restart] notebook not found: ${this.notebookUri}`);
      return;
    }

    try {
      const { tempFilePath, mappings } = await generateTempFile(
        notebook,
        this.upToCellIndex,
      );
      this.mapping = await resolveAndCreateMapping(tempFilePath, mappings);
      trackerLog(`[restart] regenerated temp file: ${this.mapping.tempFilePath}`);
    } catch (err) {
      trackerLog(`[restart] failed to regenerate: ${err}`);
    }
  }

  /** Delete temp file and dispose the termination listener. */
  async cleanup(): Promise<void> {
    try {
      await fs.unlink(this.mapping.tempFilePath);
    } catch {
      // Ignore — file may already be gone
    }
    this.onTerminated();
  }
}

let activeSession: DebugSessionState | undefined;

/** Get the current active debug session state (if any). */
export function getActiveSession(): DebugSessionState | undefined {
  return activeSession;
}

// ── Launch helper ────────────────────────────────────────────────────

export async function launchDebugSession(
  notebook: vscode.NotebookDocument,
  sessionName: string,
  upToCellIndex?: number,
): Promise<void> {
  // If there's stale state from a previous session, check if it's still running.
  if (activeSession) {
    const currentDebugSession = vscode.debug.activeDebugSession;
    if (
      currentDebugSession?.type === "maxima" &&
      NOTEBOOK_DEBUG_NAMES.includes(currentDebugSession.name)
    ) {
      vscode.window.showWarningMessage(
        "A notebook debug session is already active. Stop it before starting a new one.",
      );
      return;
    }
    // Previous session ended — clean up stale state before fresh launch.
    await activeSession.cleanup();
    activeSession = undefined;
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
    // The save may replace the document object (untitled -> file).
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

  const mapping = await resolveAndCreateMapping(tempFilePath, mappings);

  activeSession = new DebugSessionState(
    mapping,
    doc.uri.toString(),
    upToCellIndex,
  );
  activeSession.watchTermination();

  // Set cwd to the notebook's directory so relative load()/batchload()
  // paths in user code resolve correctly.
  const notebookDir = path.dirname(doc.uri.fsPath);

  const config: vscode.DebugConfiguration = {
    type: "maxima",
    request: "launch",
    name: sessionName,
    program: mapping.tempFilePath,
    stopOnEntry: false,
    ...(notebookDir ? { cwd: notebookDir } : {}),
  };

  const folder = vscode.workspace.workspaceFolders?.[0];
  const started = await vscode.debug.startDebugging(folder, config);
  if (!started) {
    await activeSession.cleanup();
    activeSession = undefined;
    vscode.window.showErrorMessage("Failed to start the debug session.");
  }
}
