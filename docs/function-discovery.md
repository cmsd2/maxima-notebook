# Function Discovery and Documentation

How users find and learn about Maxima functions in the extension.

## Current features

### LSP-powered (maxima-lsp)

- **Autocomplete**: 2500+ built-in functions, package functions, and user-defined
  symbols. Triggers on `(`, `,`, `_`, `%`. Shows signatures and descriptions.
  Limited to 50 results per query.
- **Hover documentation**: Hover over any symbol to see signatures, full
  description, examples, and see-also links. Falls back through full docs, catalog
  entry, and user-defined function info.
- **Signature help**: Parameter hints while typing inside function calls. Triggers
  on `(` and `,`.
- **Go to Definition / Find References**: For user-defined functions and variables.
- **Document and workspace symbols**: `Cmd+Shift+O` (file) and `Cmd+T` (workspace).

### MCP tools (aximar-mcp, AI-only)

These are available to Copilot, Claude, and other LM agents but not directly to
the user:

- `search_functions` — BM25 full-text search across all functions (name weighted
  3x, keywords 2x, description 1x).
- `get_function_docs` — Full Markdown documentation for a named function, with
  fuzzy fallback.
- `complete_function` — Prefix-based autocomplete returning signatures.
- `search_packages` / `list_packages` / `get_package` — Browse and search 100+
  loadable packages.
- `list_deprecated` — Obsolete functions with replacement suggestions.

### Templates

12 template notebooks with worked examples covering plotting, statistics, linear
algebra, calculus, etc.

## Gaps

The main gap is that the powerful search and browsing capabilities in aximar-core
are only exposed to AI agents via MCP. A user who wants to find "the function that
computes eigenvalues" has to either already know the name (`eigenvalues`) or ask
an AI. There is no interactive search, browsable reference, or categorised index
in the editor.

## Options

### 1. Documentation search command (QuickPick)

A VS Code command (`Maxima: Search Documentation`) that opens a QuickPick with
type-ahead search. The user types a query (e.g. "matrix inverse"), sees ranked
results with signatures and one-line descriptions, and selects one to view full
docs in a hover-like panel or output channel.

**Effort**: Low. The BM25 search engine and catalog already exist in aximar-core.
The extension would send a custom LSP request and render results in a QuickPick.

**Implementation**:
- Add a custom LSP request (`maxima/searchFunctions`) to maxima-lsp that wraps
  `CatalogSearch::search`.
- Register a VS Code command that calls the request, populates a QuickPick, and
  shows the selected function's docs.
- Optionally insert a snippet or open a hover panel on selection.

**Pros**: Minimal UI work, familiar VS Code pattern, directly solves "how do I
find the function I need?".

**Cons**: Linear list — no category browsing, no cross-references.

### 2. Documentation webview panel

A sidebar or editor panel showing full function documentation with:
- Categorised function index (Calculus, Linear Algebra, Plotting, etc.)
- Full-text search
- Rendered Markdown with syntax-highlighted examples
- Cross-references (see-also links navigate within the panel)
- "Insert example" button for notebook cells

**Effort**: Medium. Needs a webview with HTML/CSS, message passing between
extension and webview, and rendering logic. The data is all available via the
catalog and docs.

**Implementation**:
- Create a `WebviewViewProvider` registered in the sidebar (or as an editor panel).
- Fetch function data via custom LSP requests or bundle the catalog JSON.
- Render with a simple HTML template (or a lightweight framework).
- Add "Insert into notebook" action that calls the notebook LM tool API.

**Pros**: Rich browsing experience, category navigation, examples with
one-click insertion.

**Cons**: More code to maintain, needs styling, webview security considerations.

### 3. Package browser tree view

A tree view in the Activity Bar or sidebar listing all available packages, their
functions, and descriptions. Selecting a function shows its docs. A context menu
action inserts `load(package_name)` into the current cell.

**Effort**: Low-medium. VS Code tree views are straightforward. Package data is
already structured in aximar-core.

**Implementation**:
- Register a `TreeDataProvider` for the sidebar.
- Top-level items: package names (with function count).
- Children: functions in each package with signatures.
- Selection triggers a hover-like doc display.
- Context menu: "Load package", "Insert function call".

**Pros**: Always visible, browsable hierarchy, natural for exploring packages.

**Cons**: Only covers package functions, not the full built-in catalog (unless
categories are added as top-level nodes alongside packages).

### 4. Code actions / CodeLens for docs

A CodeLens or Code Action on function calls that offers "View documentation" or
"Show examples". Clicking opens the docs in a panel (option 2) or a temporary
hover.

**Effort**: Low (on top of option 2 or a simpler display). Needs a
`CodeLensProvider` or `CodeActionProvider` in the LSP.

**Pros**: Contextual — appears exactly where the user needs it.

**Cons**: Only useful when you already have code; doesn't help with discovery.

### 5. Categorised cheat sheet

A static or semi-dynamic reference card organised by topic:
- Calculus: `integrate`, `diff`, `limit`, `taylor`, ...
- Linear Algebra: `invert`, `eigenvalues`, `determinant`, ...
- Plotting: `ax_plot2d`, `ax_draw3d`, ...

Could be a webview panel, a Markdown file opened in a tab, or a QuickPick with
category filtering.

**Effort**: Low. Mostly editorial — curating the function lists per category.
Display can reuse option 1 or 2.

**Pros**: Great for newcomers, gives a "lay of the land" overview.

**Cons**: Static content goes stale; needs maintenance as functions are added.

### 6. Interactive examples / scratchpad

A command that inserts a working example for a selected function into a new or
existing notebook cell, ready to execute. Combined with option 1 or 2, this
turns documentation into a hands-on learning tool.

**Effort**: Low (if examples already exist in the catalog — they do).

**Pros**: Learn by doing, immediate feedback.

**Cons**: Only as good as the example coverage in the catalog.

## Recommendations

**Quick win**: Option 1 (QuickPick search). Directly exposes the existing search
engine to users with minimal UI work. Could be shipped in a single session.

**Next step**: Option 3 (package browser) as a sidebar tree view. Complements
the search command with a browsable hierarchy.

**Longer term**: Option 2 (webview panel) combining search, categories, and
examples in a single polished experience. Options 4-6 layer on top naturally.
