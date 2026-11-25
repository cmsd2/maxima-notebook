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

**File:** `src/notebook/serializer.ts`

Converts between Jupyter's `.ipynb` JSON format and VS Code's `NotebookData`.

### Deserialization (file → editor)

1. Parse JSON into `IpynbNotebook` structure
2. Map each `IpynbCell` to `NotebookCellData`:
   - `cell_type: "code"` → `NotebookCellKind.Code` with `languageId: "maxima"`
   - `cell_type: "markdown"` → `NotebookCellKind.Markup` with `languageId: "markdown"`
   - `cell_type: "raw"` → filtered out
3. Restore outputs from `outputs[].data` MIME bundles:
   - `text/latex` in ipynb → `application/x-maxima-latex` in VS Code
   - `application/x-maxima-plotly` preserved as-is
   - `image/svg+xml`, `text/plain` preserved as-is
4. Restore `execution_count` into `executionSummary`
5. If file is empty or invalid, return a single empty code cell

### Serialization (editor → file)

1. Map each `NotebookCellData` back to `IpynbCell`
2. Split cell source by newlines (ipynb stores source as `string[]`)
3. Map MIME types back to ipynb conventions:
   - `application/x-maxima-latex` → `text/latex` for Aximar/Jupyter compat
4. Always include `text/plain` fallback in output data
5. Write metadata with kernel spec:
   ```json
   {
     "kernelspec": {
       "name": "maxima",
       "display_name": "Maxima",
       "language": "maxima"
     }
   }
   ```
6. Preserve `metadata.aximar` if present (template_id, title, description)

### ipynb Format Reference

The `.ipynb` format matches Aximar's implementation in
`aximar-core/src/notebooks/types.rs`:

```json
{
  "nbformat": 4,
  "nbformat_minor": 5,
  "metadata": {
    "kernelspec": { "name": "maxima", "display_name": "Maxima", "language": "maxima" },
    "aximar": { "template_id": null, "title": null, "description": null }
  },
  "cells": [
    {
      "cell_type": "code",
      "source": ["integrate(x^2, x);"],
      "metadata": {},
      "execution_count": 1,
      "outputs": [
        {
          "output_type": "execute_result",
          "data": {
            "text/plain": "x^3/3",
            "text/latex": "{{x^3}\\over{3}}"
          },
          "metadata": {},
          "execution_count": 1
        }
      ]
    }
  ]
}
```

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
  plot_svg?: string | null;
  plot_data?: string | null;
  error?: string | null;
  is_error: boolean;
  duration_ms: number;
  output_label?: string | null;
  execution_count?: number | null;  // the run's gutter number
}
```

These fields map to VS Code notebook outputs:

| Field | Condition | MIME Type | Renderer |
|-------|-----------|-----------|----------|
| `error` | `is_error === true` | error output | Native VS Code |
| `text_output` | Non-empty, separate from result | `text/plain` | Native |
| `latex` | Present | `application/x-maxima-latex` | Custom (KaTeX) |
| `plot_svg` | Present | `image/svg+xml` | Native |
| `plot_data` | Present | `application/x-maxima-plotly` | Custom (Plotly) |

When a cell produces multiple output types (e.g., both LaTeX and a plot),
they are placed in separate `NotebookCellOutput` objects so they render
as distinct output blocks.

Text output (`print()` statements, warnings, provisos) renders above the
main result, mimicking Jupyter behavior.

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
