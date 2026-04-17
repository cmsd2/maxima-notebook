import * as vscode from "vscode";
import MarkdownIt from "markdown-it";
import { LanguageClient } from "vscode-languageclient/node";

const md = new MarkdownIt();

// Turn [name](fn:name) cross-reference links into navigable see-also links
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const hrefIdx = tokens[idx].attrIndex("href");
  if (hrefIdx >= 0) {
    const href = tokens[idx].attrs![hrefIdx][1];
    if (href.startsWith("fn:")) {
      const name = href.slice(3);
      tokens[idx].attrs![hrefIdx][1] = "#";
      tokens[idx].attrPush(["class", "see-also-link"]);
      tokens[idx].attrPush(["data-name", name]);
    }
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

interface SearchResult {
  name: string;
  signature: string;
  description: string;
  category: string | null;
  score: number;
  package: string | null;
}

interface FunctionDocs {
  name: string;
  signatures: string[];
  description: string;
  category: string | null;
  examples: { input: string; description: string | null }[];
  see_also: string[];
  full_docs: string | null;
  package: string | null;
}

let docsPanel: vscode.WebviewPanel | undefined;

export function searchDocumentation(client: LanguageClient): void {
  const quickPick = vscode.window.createQuickPick();
  quickPick.placeholder = "Search Maxima functions (e.g. matrix inverse, integrate)";
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  quickPick.onDidChangeValue((value) => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    if (!value.trim()) {
      quickPick.items = [];
      return;
    }
    quickPick.busy = true;
    debounceTimer = setTimeout(async () => {
      try {
        const results = await client.sendRequest<SearchResult[]>(
          "workspace/executeCommand",
          {
            command: "maxima.searchFunctions",
            arguments: [{ query: value }],
          },
        );
        quickPick.items = (results ?? []).map((r) => ({
          label: r.name,
          description: r.signature || undefined,
          detail: formatDetail(r),
        }));
      } catch {
        // Search failed silently — keep previous results
      } finally {
        quickPick.busy = false;
      }
    }, 150);
  });

  quickPick.onDidAccept(async () => {
    const selected = quickPick.selectedItems[0];
    if (!selected) {
      return;
    }
    quickPick.hide();
    await showFunctionDocs(client, selected.label);
  });

  quickPick.onDidHide(() => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    quickPick.dispose();
  });

  quickPick.show();
}

function formatDetail(r: SearchResult): string {
  const parts: string[] = [];
  if (r.category) {
    parts.push(r.category);
  }
  if (r.package) {
    parts.push(`pkg: ${r.package}`);
  }
  if (r.description) {
    parts.push(r.description);
  }
  return parts.join(" — ");
}

async function showFunctionDocs(
  client: LanguageClient,
  name: string,
): Promise<void> {
  let docs: FunctionDocs;
  try {
    docs = await client.sendRequest<FunctionDocs>(
      "workspace/executeCommand",
      {
        command: "maxima.getFunctionDocs",
        arguments: [{ name }],
      },
    );
  } catch {
    vscode.window.showWarningMessage(`No documentation found for "${name}".`);
    return;
  }

  if (!docs) {
    vscode.window.showWarningMessage(`No documentation found for "${name}".`);
    return;
  }

  if (docsPanel) {
    docsPanel.title = `Maxima: ${docs.name}`;
    docsPanel.webview.html = renderDocsHtml(docs);
    docsPanel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    docsPanel = vscode.window.createWebviewPanel(
      "maxima-docs",
      `Maxima: ${docs.name}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true },
    );
    docsPanel.webview.html = renderDocsHtml(docs);
    docsPanel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "navigate" && msg.name) {
        await showFunctionDocs(client, msg.name);
      }
    });
    docsPanel.onDidDispose(() => {
      docsPanel = undefined;
    });
  }
}

function renderDocsHtml(docs: FunctionDocs): string {
  const signatures = docs.signatures
    .map((s) => escapeHtml(s))
    .join("\n");

  const categoryBadge = docs.category
    ? `<span class="badge">${escapeHtml(docs.category)}</span>`
    : "";

  const packageBadge = docs.package
    ? `<span class="badge pkg">pkg: ${escapeHtml(docs.package)}</span>`
    : "";

  // When full_docs is available, use it as the main body content (rendered markdown).
  // The LSP inlines images as base64 data URIs, so they render without local file access.
  // Only fall back to the structured catalog fields when there's no full_docs.
  let bodyHtml: string;
  if (docs.full_docs) {
    bodyHtml = `<div class="full-docs">${md.render(docs.full_docs)}</div>`;
  } else {
    const parts: string[] = [];
    if (docs.description) {
      parts.push(`<p class="description">${escapeHtml(docs.description)}</p>`);
    }
    if (docs.examples.length > 0) {
      const items = docs.examples
        .map((ex) => {
          const desc = ex.description
            ? `<p class="example-desc">${escapeHtml(ex.description)}</p>`
            : "";
          return `${desc}<pre class="example"><code>${escapeHtml(ex.input)}</code></pre>`;
        })
        .join("\n");
      parts.push(`<h2>Examples</h2>\n${items}`);
    }
    bodyHtml = parts.join("\n");
  }

  // See-also links are always useful (they're interactive)
  let seeAlsoHtml = "";
  if (docs.see_also.length > 0) {
    const links = docs.see_also
      .map(
        (name) =>
          `<a href="#" class="see-also-link" data-name="${escapeHtml(name)}">${escapeHtml(name)}</a>`,
      )
      .join(", ");
    seeAlsoHtml = `<h2>See Also</h2><p>${links}</p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body {
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    line-height: 1.5;
  }
  h1 { font-size: 1.5em; margin: 0 0 8px; }
  h2 { font-size: 1.15em; margin: 20px 0 8px; border-bottom: 1px solid var(--vscode-widget-border, #444); padding-bottom: 4px; }
  .badge {
    display: inline-block;
    font-size: 0.85em;
    padding: 2px 8px;
    border-radius: 4px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    margin-right: 6px;
  }
  .badge.pkg { opacity: 0.85; }
  .description { margin: 8px 0; }
  pre {
    background: var(--vscode-textCodeBlock-background, #1e1e1e);
    padding: 10px 12px;
    border-radius: 4px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
  code { font-family: var(--vscode-editor-font-family, monospace); }
  .signature { margin: 8px 0; }
  .example { margin: 4px 0 12px; }
  .example-desc { margin: 4px 0; font-style: italic; opacity: 0.8; }
  .full-docs p { margin: 8px 0; }
  .full-docs img { max-width: 100%; height: auto; }
  a.see-also-link {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    cursor: pointer;
  }
  a.see-also-link:hover { text-decoration: underline; }
</style>
</head>
<body>
  <h1>${escapeHtml(docs.name)}</h1>
  ${categoryBadge}${packageBadge}
  ${signatures ? `<div class="signature"><pre><code>${signatures}</code></pre></div>` : ""}
  ${bodyHtml}
  ${seeAlsoHtml}
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.see-also-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'navigate', name: link.dataset.name });
      });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
