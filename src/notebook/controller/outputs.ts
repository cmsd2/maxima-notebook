/**
 * Output building: convert EvalResult to VS Code notebook outputs.
 */

import * as vscode from "vscode";
import type { EvalResult } from "../types";

/** Convert an evaluation result to notebook cell outputs. */
export function buildOutputs(result: EvalResult): vscode.NotebookCellOutput[] {
  if (result.is_error) {
    const message = result.error || result.text_output || "Evaluation error";
    return [
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.error(new Error(message)),
      ]),
    ];
  }

  const outputs: vscode.NotebookCellOutput[] = [];

  // Text output from print()/tex() side effects — shown as plain text
  if (result.text_output) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          result.text_output,
          "text/plain",
        ),
      ]),
    );
  }

  // Final result as LaTeX (from injected tex(%))
  if (result.latex) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          result.latex,
          "application/x-maxima-latex",
        ),
      ]),
    );
  }

  // SVG plot — renders natively in VS Code
  if (result.plot_svg) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          shrinkSvg(result.plot_svg),
          "image/svg+xml",
        ),
      ]),
    );
  }

  // PNG image — renders natively in VS Code
  if (result.image_png) {
    const pngBytes = Buffer.from(result.image_png, "base64");
    outputs.push(
      new vscode.NotebookCellOutput([
        new vscode.NotebookCellOutputItem(pngBytes, "image/png"),
      ]),
    );
  }

  // Plotly data — interactive chart via custom renderer
  if (result.plot_data) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          result.plot_data,
          "application/x-maxima-plotly",
        ),
        vscode.NotebookCellOutputItem.text(result.plot_data, "text/plain"),
      ]),
    );
  }

  return outputs;
}

/**
 * Make an SVG responsive by replacing fixed width/height with a max-width
 * style.  gnuplot emits e.g. `<svg width="600" height="480" ...>` which
 * causes VS Code to allocate that exact space even when `set size` shrinks
 * the plot inside the canvas.  By removing the fixed dimensions and relying
 * on the viewBox, the SVG scales to fit its container without wasted space.
 */
function shrinkSvg(svg: string): string {
  return svg.replace(
    /(<svg\b[^>]*?)\s+width="(\d+)"\s+height="(\d+)"/,
    (_match, prefix, w, h) => {
      // Ensure a viewBox exists so the aspect ratio is preserved
      const hasViewBox = /viewBox\s*=/.test(prefix);
      const viewBox = hasViewBox ? "" : ` viewBox="0 0 ${w} ${h}"`;
      return `${prefix}${viewBox} style="max-width:${w}px"`;
    },
  );
}

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
