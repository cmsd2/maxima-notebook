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
