/**
 * Helpers for running cells. Outputs are built in ../notebookFile.ts, so
 * a run and a file read show a result the same way.
 */

/** Race a promise against a timeout. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
