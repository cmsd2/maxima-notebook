/**
 * Breakpoint migration for notebook debugging.
 *
 * When a notebook's URI changes (e.g. untitled -> file save), existing
 * breakpoints still reference the old cell URIs.  This module migrates
 * orphaned breakpoints to the current notebook cell URIs at debug launch.
 */

import * as vscode from "vscode";
import { trackerLog } from "./helpers";

/**
 * Extract the notebook portion from a vscode-notebook-cell URI (strip fragment).
 * e.g. "vscode-notebook-cell:Untitled-1.macnb?maxima-notebook#frag" ->
 *      "vscode-notebook-cell:Untitled-1.macnb?maxima-notebook"
 */
function cellUriNotebookPart(cellUri: string): string {
  const hashIdx = cellUri.indexOf("#");
  return hashIdx >= 0 ? cellUri.substring(0, hashIdx) : cellUri;
}

/**
 * Migrate orphaned breakpoints at debug launch time.
 *
 * When a notebook's URI changes (e.g. untitled -> file save), existing
 * breakpoints still reference the old cell URIs. This function finds
 * vscode-notebook-cell breakpoints that don't belong to any currently-open
 * notebook and migrates them to the notebook being debugged.
 *
 * To avoid migrating breakpoints from OTHER closed notebooks, we only
 * migrate orphaned cell URIs whose notebook-part prefix doesn't match
 * any open notebook's cell URIs.
 */
export function migrateOrphanedBreakpoints(
  notebook: vscode.NotebookDocument,
): void {
  // Current cell URIs for the notebook being debugged
  const currentCellUris = new Set<string>();
  for (let i = 0; i < notebook.cellCount; i++) {
    currentCellUris.add(notebook.cellAt(i).document.uri.toString());
  }

  // If any breakpoints already match the current cell URIs, the notebook
  // hasn't changed URI -- no migration needed.
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
      continue; // Already matches the current notebook -- no migration needed
    }
    const nbPart = cellUriNotebookPart(uri);
    if (openNotebookCellPrefixes.has(nbPart)) {
      continue; // Belongs to another open notebook -- don't touch
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

  // Only migrate breakpoints from untitled notebooks (untitled -> file save).
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
        `[migrateOrphanedBreakpoints] ${oldCellUri} -> ${newCellUri} line ${bp.location.range.start.line + 1}`,
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
