/**
 * Custom notebook renderer for Maxima output: LaTeX math (KaTeX),
 * interactive charts (Plotly.js), and styled text output.
 */

import type { ActivationFunction, OutputItem } from "vscode-notebook-renderer";
import katex from "katex";
import "katex/dist/katex.min.css";
import "./style.css";

export const activate: ActivationFunction = (_context) => ({
  renderOutputItem(data: OutputItem, element: HTMLElement): void {
    switch (data.mime) {
      case "application/x-maxima-latex":
        renderLatex(data.text(), element);
        break;
      case "application/x-maxima-plotly":
        renderPlotly(data.text(), element);
        break;
      case "application/x-maxima-output":
        renderTextOutput(data.text(), element);
        break;
    }
  },
  disposeOutputItem(id?: string): void {
    if (id) {
      const el = document.getElementById(id);
      if (el && plotlyElements.has(el)) {
        Plotly?.purge(el);
        plotlyElements.delete(el);
      }
    }
  },
});

// ── LaTeX ──────────────────────────────────────────────────────────────

function renderLatex(latex: string, element: HTMLElement): void {
  element.classList.add("maxima-latex-output");
  try {
    katex.render(preprocessLatex(latex), element, {
      displayMode: true,
      throwOnError: false,
      trust: true,
      output: "htmlAndMathml",
    });
  } catch {
    // Fallback: show raw TeX
    element.textContent = latex;
  }
}

/**
 * Preprocess Maxima's tex() output for KaTeX compatibility.
 * Ported from aximar/src/lib/katex-helpers.ts.
 */
function preprocessLatex(latex: string): string {
  let result = latex;

  // Replace {\it content} with \mathit{content}
  result = result.replace(/\{\\it\s+([^}]*)\}/g, "\\mathit{$1}");

  // Strip Maxima's \ifx\endpmatrix\undefined...\else...\fi conditionals.
  // Keep the LaTeX branch (\begin{pmatrix} / \end{pmatrix}).
  result = result.replace(
    /\\ifx\\endpmatrix\\undefined\\pmatrix\{\\else\\begin\{pmatrix\}\\fi/g,
    "\\begin{pmatrix}",
  );
  result = result.replace(
    /\\ifx\\endpmatrix\\undefined\}\\else\\end\{pmatrix\}\\fi/g,
    "\\end{pmatrix}",
  );

  // Replace \cr row separators with \\ (strip trailing \cr before \end)
  result = result.replace(/\\cr\s*\\end\{pmatrix\}/g, "\\end{pmatrix}");
  result = result.replace(/\\cr/g, "\\\\");

  // Replace \mbox with \text (better supported in KaTeX)
  result = result.replace(/\\mbox\{/g, "\\text{");

  // Handle any remaining plain \pmatrix{...} (older Maxima versions)
  result = replacePmatrix(result);

  return result;
}

/**
 * Find \pmatrix{...} with balanced brace matching and convert to
 * \begin{pmatrix}...\end{pmatrix}, replacing \cr row separators with \\.
 */
function replacePmatrix(latex: string): string {
  const prefix = "\\pmatrix{";
  let result = "";
  let i = 0;

  while (i < latex.length) {
    const idx = latex.indexOf(prefix, i);
    if (idx === -1) {
      result += latex.substring(i);
      break;
    }

    result += latex.substring(i, idx);
    const contentStart = idx + prefix.length;

    // Walk forward counting braces to find the matching close
    let depth = 1;
    let j = contentStart;
    while (j < latex.length && depth > 0) {
      if (latex[j] === "{") depth++;
      else if (latex[j] === "}") depth--;
      j++;
    }

    if (depth === 0) {
      let content = latex.substring(contentStart, j - 1);
      content = content.replace(/\\cr\s*$/, "");
      content = content.replace(/\\cr/g, "\\\\");
      result += "\\begin{pmatrix}" + content + "\\end{pmatrix}";
      i = j;
    } else {
      // Unbalanced — keep original text and move past the prefix
      result += prefix;
      i = contentStart;
    }
  }

  return result;
}

// ── Plotly ─────────────────────────────────────────────────────────────

let Plotly: typeof import("plotly.js-dist-min") | undefined;
const plotlyElements = new Set<HTMLElement>();

async function renderPlotly(
  jsonStr: string,
  element: HTMLElement,
): Promise<void> {
  element.classList.add("maxima-plotly-output");

  let spec: { data: unknown[]; layout?: Record<string, unknown> };
  try {
    spec = JSON.parse(jsonStr);
  } catch {
    element.textContent = "Invalid Plotly JSON";
    return;
  }

  // Lazy-load Plotly on first use (~1MB)
  if (!Plotly) {
    try {
      Plotly = await import("plotly.js-dist-min");
    } catch (err) {
      element.textContent = `Failed to load Plotly: ${err}`;
      return;
    }
  }

  // Clear previous content to avoid duplicate plots on re-run
  element.innerHTML = "";

  const plotDiv = document.createElement("div");
  plotDiv.style.width = "100%";
  plotDiv.style.minHeight = "400px";
  element.appendChild(plotDiv);

  // Apply VS Code theme colors
  const layout = {
    ...spec.layout,
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: {
      color: "var(--vscode-editor-foreground)",
      family: "var(--vscode-font-family)",
    },
    xaxis: {
      ...(spec.layout?.xaxis as Record<string, unknown> | undefined),
      gridcolor: "var(--vscode-editorWidget-border)",
      zerolinecolor: "var(--vscode-editorWidget-border)",
    },
    yaxis: {
      ...(spec.layout?.yaxis as Record<string, unknown> | undefined),
      gridcolor: "var(--vscode-editorWidget-border)",
      zerolinecolor: "var(--vscode-editorWidget-border)",
    },
  };

  const config = {
    responsive: true,
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ["sendDataToCloud" as const],
  };

  await Plotly.newPlot(plotDiv, spec.data as Plotly.Data[], layout, config);
  plotlyElements.add(plotDiv);
}

// ── Text Output ────────────────────────────────────────────────────────

function renderTextOutput(text: string, element: HTMLElement): void {
  element.classList.add("maxima-text-output");
  element.innerHTML = "";
  const pre = document.createElement("pre");
  pre.textContent = text;
  element.appendChild(pre);
}
