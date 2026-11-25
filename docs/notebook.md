# Notebook Integration

VS Code Notebook API integration for running Maxima `.ipynb` notebooks.

## Components

The notebook feature has three VS Code API components:

1. **NotebookSerializer** — reads/writes `.ipynb` files
2. **NotebookController** — handles cell execution via aximar-mcp
3. **NotebookRenderer** — renders rich output (KaTeX, Plotly, SVG)

These are registered in `package.json` under the `maxima-notebook` notebook
type with `priority: "option"`, meaning VS Code offers it as an alternative
handler for `.ipynb` files alongside the Jupyter extension.

## NotebookSerializer

**Files:** `src/notebook/serializer.ts`, `src/notebook/notebookFile.ts`, `src/notebook/cellIds.ts`

Notebook files follow Aximar's format, described in
[`docs/notebook-format.md`](https://github.com/cmsd2/aximar/blob/master/docs/notebook-format.md)
in the aximar repository: Jupyter nbformat 4.5 with cell IDs. The
[`aximar-notebook-format`](https://www.npmjs.com/package/aximar-notebook-format)
package reads and writes them. It's the Rust code Aximar uses, built as
WebAssembly, so the extension and Aximar write the same bytes. The build
copies its `.wasm` file into `out/` next to the bundle.

`notebookFile.ts` maps the package's model to VS Code's:

| File | VS Code |
|------|---------|
| Code cell | Code cell, language `maxima` |
| Markdown cell | Markup cell |
| Raw cell | Code cell, language `raw`: shown as text, never run, written back unchanged |
| Cell `id` | `metadata.id` |
| Cell `metadata` | `metadata.metadata` (kept as read) |
| Other cell fields (`attachments`) | `metadata.extra` |
| A cell's output | VS Code outputs, one per part (below) |
| Outputs of other kinds | `metadata.otherOutputs`, written back until the cell runs |
| `execution_count` | the cell's execution order |

Notebook metadata, `metadata.aximar` included, is kept. An empty file
opens as a notebook with one empty cell; a file that isn't a notebook
fails to open with the package's error, rather than opening empty and
being overwritten on save.

### Cell IDs

A cell read from a file keeps its ID if it's valid and unique; otherwise
the package gives it a new one. A cell added in VS Code gets an ID as it's
added, and a pasted copy gets its own (`cellIds.ts`, which listens for
added cells). Saving checks again, so the file never has a missing or
repeated ID.

### Outputs

Each VS Code output holds one part of a run, tagged in the output's
metadata (`part`): print text, the result, a plot or the error. Saving
reads them back by part, so a plot's `text/plain` fallback is never taken
for print text. The result's one-line form (`text_plain` from aximar-mcp)
rides in the result output's metadata and is saved as its `text/plain`;
aximar-mcp 0.6.0 doesn't send it, so those results are saved with LaTeX
only. An SVG plot is shown resized to fit the editor, and saved as
received.

## NotebookController

**File:** `src/notebook/controller.ts`

Manages cell execution by communicating with aximar-mcp.

### Registration

```typescript
const controller = vscode.notebooks.createNotebookController(
  "maxima-notebook-controller",
  "maxima-notebook",
  "Maxima"
);
controller.supportedLanguages = ["maxima"];
controller.supportsExecutionOrder = true;
controller.executeHandler = executeCells;
controller.interruptHandler = interruptExecution;
```

### Cell Execution Flow

Cells are executed **sequentially** (Maxima is stateful — each cell builds
on the previous state).

1. **Create execution**: `controller.createNotebookCellExecution(cell)`
2. **Check the server**: the aximar-mcp must take `cell_id`; see
   [Older aximar-mcp](#older-aximar-mcp) below
3. **Call MCP**: `mcpClient.evaluateExpression(source, sessionId, { id, above })`
   with the cell's source unchanged; see [Labels](#labels) below
4. **Show the number**: `execution.executionOrder` takes the returned
   `execution_count`
5. **Map outputs**: see [Output Mapping](#output-mapping) below
6. **Complete execution**: `execution.end(success, timestamp)`

### Output Mapping

The `evaluate_expression` MCP tool returns:

```typescript
interface EvalResult {
  text_output: string;
  latex?: string | null;
  text_plain?: string | null;  // the result's one-line form, after tools 0.6.0
  plot_svg?: string | null;
  plot_data?: string | null;
  image_png?: string | null;
  error?: string | null;
  is_error: boolean;
  duration_ms: number;
  output_label?: string | null;
  execution_count?: number | null;  // the run's gutter number
}
```

`buildOutputs` in `notebookFile.ts` turns it into VS Code outputs, in the
order the file keeps them, the same way it shows outputs read from a file:

| Field | MIME type | Renderer |
|-------|-----------|----------|
| `text_output` (print text) | `text/plain` | Native |
| `latex` | `application/x-maxima-latex` | Custom (KaTeX) |
| `plot_data` | `application/x-maxima-plotly` | Custom (Plotly) |
| `plot_svg` | `image/svg+xml` | Native |
| `image_png` | `image/png` | Native |
| `error` | error output | Native |

When a run fails, aximar-mcp puts its print text in `error`, so the error
shows it.

### Interrupt / Restart

- **Interrupt**: Calls `restartSession(notebookId)` on aximar-mcp. This
  kills the current Maxima process and starts a fresh one. (Maxima does not
  reliably support mid-evaluation interrupts.)
- **Restart Kernel**: Same mechanism. aximar-mcp forgets the cells' runs
  and numbers from 1 again. Available as a toolbar button.

## Labels

aximar-mcp resolves `%oN` and `%`, the same way the Aximar window does.
Each call to `evaluate_expression` carries:

- `cell_id`: the cell's document URI, fixed while the notebook is open
- `cells_above`: the URIs of the code cells above it, top first

The server gives the run the next number in the session, rewrites `%oN`
to the Maxima label of the run numbered N, and rewrites a bare `%` to the
output of the nearest cell above that has one in this session. It records
the run against the cell and returns its number as `execution_count`. A
label with no value in the session (`%o9` before nine runs, or after a
restart) fails in its own cell.

| Cell | Source | Number | Result |
|------|--------|--------|--------|
| 1 | `10;` | 1 | 10 |
| 2 | `5;` | 2 | 5 |
| 3 | `%o1 + %;` | 3 | 15 |

`%e`, `%pi`, `%th(n)`, `%%` and `%`-prefixed names keep Maxima's meaning.

Version 0.3.0 and earlier rewrote labels in the extension and stored
`outputLabel` and `executionCount` in cell metadata. The controller removes
those keys from a cell when it runs.

### Older aximar-mcp

tools-v0.5.0 and earlier ignore `cell_id`, so `%o1` would reach Maxima
unchanged. After connecting, the extension reads `tools/list`; when
`evaluate_expression` doesn't take `cell_id` and `cells_above`, cells fail
with a message naming the binary, and the extension offers to download the
tools, build them with cargo, or open the `maxima.notebook.mcpPath`
setting. The rest of the run fails with the same message, and the
extension stops that aximar-mcp, so the next run starts the binary again
and checks the update. Changing `maxima.notebook.mcpPath` also stops it.
The download refuses releases older than `MIN_TOOLS_VERSION`
(`src/toolsVersion.ts`). The check reads the schema rather than a version
number, so builds from source work too.

### Unicode Translation

`evaluate_expression` in aximar-mcp already calls `unicode_to_maxima()`
(converting Unicode Greek letters to Maxima identifiers). This does NOT
need to be duplicated in the extension.

## Notebook Type Registration

```json
{
  "contributes": {
    "notebooks": [{
      "type": "maxima-notebook",
      "displayName": "Maxima Notebook",
      "selector": [{ "filenamePattern": "*.ipynb" }],
      "priority": "option"
    }]
  }
}
```

**`priority: "option"`** means VS Code shows this as an alternative handler.
When opening an `.ipynb` file, the user can choose between the Jupyter
extension (if installed) and the Maxima extension. Users can set
`workbench.editorAssociations` to prefer Maxima for specific files or
folders:

```json
{
  "workbench.editorAssociations": {
    "*.ipynb": "maxima-notebook"
  }
}
```

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxima.notebook.mcpPath` | string | `""` | Path to aximar-mcp binary. Searches PATH if empty. |
| `maxima.notebook.evalTimeout` | number | `60` | Cell evaluation timeout in seconds. |

## LSP in Notebook Cells

The LSP client's `documentSelector` includes:

```typescript
{ scheme: "vscode-notebook-cell", language: "maxima" }
```

This enables completions, hover, diagnostics, and signature help inside
notebook code cells. Each cell is a separate document to the LSP.

**Limitation:** Cross-cell references don't work. A function `f(x)` defined
in cell 1 is not visible to the LSP when editing cell 3, because the LSP
sees each cell as an independent document. Maxima's 2500+ built-in functions
still complete correctly. A future improvement could implement
concat-document middleware to virtually stitch cells for the LSP.

## Toolbar and Commands

| Command | Title | Location |
|---------|-------|----------|
| `maxima.notebook.restartKernel` | Restart Kernel | Notebook toolbar |
| `maxima.notebook.interruptKernel` | Interrupt Kernel | Command palette |
| `maxima.notebook.debugNotebook` | Debug Notebook | Notebook toolbar |
| `maxima.notebook.debugFromCell` | Debug From This Cell | Cell title menu |
