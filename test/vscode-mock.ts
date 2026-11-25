/**
 * The parts of the vscode API the tested modules touch outside a
 * running editor.
 */

type Listener<T> = (e: T) => void;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(e: T): void {
    for (const l of this.listeners) {
      l(e);
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, fallback: T) => fallback,
  }),
};

/** An output channel that keeps its lines for assertions. */
export function outputChannel(): { lines: string[]; appendLine(line: string): void } {
  const lines: string[] = [];
  return { lines, appendLine: (line: string) => lines.push(line) };
}

// ── Notebooks ────────────────────────────────────────────────────────

export enum NotebookCellKind {
  Markup = 1,
  Code = 2,
}

export class NotebookCellOutputItem {
  constructor(
    public data: Uint8Array,
    public mime: string,
  ) {}
  static text(value: string, mime = "text/plain"): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), mime);
  }
  static error(err: Error): NotebookCellOutputItem {
    const value = { name: err.name, message: err.message, stack: err.stack };
    return NotebookCellOutputItem.text(JSON.stringify(value), "application/vnd.code.notebook.error");
  }
}

export class NotebookCellOutput {
  constructor(
    public items: NotebookCellOutputItem[],
    public metadata?: { [key: string]: unknown },
  ) {}
}

export class NotebookCellData {
  outputs?: NotebookCellOutput[];
  metadata?: { [key: string]: unknown };
  executionSummary?: { executionOrder?: number };
  constructor(
    public kind: NotebookCellKind,
    public value: string,
    public languageId: string,
  ) {}
}

export class NotebookData {
  metadata?: { [key: string]: unknown };
  constructor(public cells: NotebookCellData[]) {}
}

export const NotebookEdit = {
  updateCellMetadata: (index: number, newCellMetadata: { [key: string]: unknown }) => ({
    index,
    newCellMetadata,
  }),
};
