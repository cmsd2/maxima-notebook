# Architecture

System architecture for the Maxima VS Code extension's notebook, AI, and
debugging features.

## Overview

The extension manages three external processes, each serving a distinct role:

| Process | Protocol | Purpose |
|---------|----------|---------|
| `aximar-mcp` | MCP over HTTP | Maxima evaluation, session management, docs catalog |
| `maxima-lsp` | LSP over stdio | Completions, hover, diagnostics, go-to-definition |
| `maxima-dap` | DAP over stdio | Breakpoints, stepping, variable inspection |

A single `aximar-mcp` instance (HTTP transport) is shared between the notebook
controller and AI agents, giving both access to the same Maxima sessions.
`maxima-lsp` and `maxima-dap` are each spawned per-need as separate processes.

## Process Model

```
┌──────────────────────────────────────────────────────────────────┐
│                      VS Code Extension Host                       │
│                                                                    │
│  ┌────────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────┐ │
│  │  Notebook   │  │   LM Tools   │  │    MCP     │  │   LSP    │ │
│  │ Controller  │  │ (registerTool│  │  Provider   │  │  Client  │ │
│  │             │  │  bridge)     │  │(registerMcp │  │          │ │
│  │ - serialize │  │              │  │ ServerDef)  │  │          │ │
│  │ - execute   │  │ - get_cells  │  │             │  │          │ │
│  │ - labels    │  │ - run_cell   │  │ Points AI → │  │          │ │
│  │             │  │ - add_cell   │  │ aximar-mcp  │  │          │ │
│  │             │  │ - debug_vars │  │             │  │          │ │
│  └──────┬─────┘  └──────┬───────┘  └──────┬──────┘  └────┬─────┘ │
│         │               │                  │               │       │
│         │  ┌────────────┘                  │               │       │
│         │  │                               │               │       │
│         ▼  ▼                               ▼               ▼       │
│  ┌───────────────────────────────┐   (same URL)    ┌────────────┐ │
│  │      aximar-mcp (HTTP)        │◄────────────    │ maxima-lsp │ │
│  │                               │                  │  (stdio)   │ │
│  │  NotebookRegistry             │                  └────────────┘ │
│  │  ├─ nb-1: Notebook + Session  │                                 │
│  │  ├─ nb-2: Notebook + Session  │         ┌────────────┐         │
│  │  └─ default: Notebook+Session │         │ maxima-dap │         │
│  │                               │         │  (stdio)   │         │
│  │  Each notebook has:           │         │ per debug  │         │
│  │  - Maxima child process       │         │  session   │         │
│  │  - Session state machine      │         └────────────┘         │
│  │  - Cell list + outputs        │                                 │
│  │  - Capture sink               │                                 │
│  └───────────────────────────────┘                                 │
└──────────────────────────────────────────────────────────────────┘
```

## aximar-mcp: Evaluation Backend

The extension spawns `aximar-mcp --http --no-auth` on first need (lazy).
This single process serves all open notebooks and AI agent connections.

**Why HTTP (not stdio)?** Stdio is a 1:1 connection. HTTP allows multiple
concurrent clients: the notebook controller connects via
`@modelcontextprotocol/sdk`'s `StreamableHTTPClientTransport`, and AI agents
connect via VS Code's built-in MCP client. Both reach the same
`NotebookRegistry`, which is shared across connections via `Arc<Mutex<...>>`.

**Multi-notebook isolation.** Each VS Code notebook document maps to a
separate `NotebookContext` in aximar-mcp's registry, identified by a
`notebook_id` (e.g., `"nb-1"`). Each context has its own Maxima child process,
session state machine, and output capture. Requests include
`notebook_id` to route to the correct session.

**Lifecycle:**

1. Extension activation (lazy, on first notebook open or MCP request)
2. Spawn `aximar-mcp --http --port <configured> --no-auth`
3. MCP provider fires `mcpChanged` → AI agents discover the server
4. Notebook open → `create_notebook()` → returns `notebook_id`
5. Cell execution → `evaluate_expression(expression, notebook_id)`
6. Notebook close → `close_notebook(notebook_id)`
7. Extension deactivation → kill the process

**Fallback.** When no notebook is open, the MCP provider can either point to
the extension-managed aximar-mcp (for AI access to docs/catalog) or fall back
to user-configured external MCP settings.

## maxima-lsp: Language Intelligence

Spawned once via `vscode-languageclient`. Provides completions, hover,
diagnostics, go-to-definition, references, and workspace symbols for `.mac`
files.

For notebook cells, the LSP client's `documentSelector` includes
`{ scheme: "vscode-notebook-cell", language: "maxima" }`. Each notebook code
cell appears as a separate virtual document. The LSP provides per-cell
intelligence (built-in function completions, syntax diagnostics) but cannot
resolve cross-cell references (a function defined in cell 1 is not visible
to the LSP when editing cell 3).

## maxima-dap: Debug Adapter

Spawned per debug session. Each session gets its own Maxima process.

At launch, maxima-dap probes the Maxima process for Enhanced debugger support
(patched Maxima with `set_breakpoint`). If detected, it uses **Enhanced mode**
with file:line breakpoints and deferred resolution. Otherwise it falls back to
**Legacy mode** with function+offset breakpoints.

For notebook debugging, the extension writes notebook cells to a temp `.mac`
file and launches maxima-dap against it. A `DebugAdapterTracker` remaps
source locations between cell URIs and the temp file so breakpoints and
stack frames appear inline in notebook cells. See [debugging.md](debugging.md)
for details.

## Data Flow: Cell Execution

```
User clicks "Run Cell"
        │
        ▼
NotebookController
  1. Read cell source from VS Code NotebookDocument
  2. Walk backwards through cells → find previousOutputLabel
  3. Build LabelContext (labelMap + previousOutputLabel)
  4. rewriteLabels(source, ctx) → rewritten source
        │
        ▼
McpClientManager.evaluateExpression(rewritten, notebookId)
        │
        ▼
aximar-mcp (HTTP)
  1. unicode_to_maxima(expression)
  2. protocol::evaluate_with_packages(process, ...)
  3. parser::parse_output() → EvalResult
        │
        ▼
Returns JSON: { text_output, latex, plot_svg, plot_data, error,
                is_error, duration_ms, output_label }
        │
        ▼
NotebookController
  1. Record output_label in cell metadata + labelMap
  2. Map fields to MIME types:
     - latex → application/x-maxima-latex
     - plot_svg → image/svg+xml
     - plot_data → application/x-maxima-plotly
     - text_output → text/plain
     - error → NotebookCellOutputItem.error()
  3. execution.replaceOutput(outputs)
  4. execution.end(success, timestamp)
        │
        ▼
VS Code renders outputs via:
  - Native renderer (text/plain, image/svg+xml)
  - Custom renderer (KaTeX for latex, Plotly for plot_data)
```

## Data Flow: AI Agent Evaluation

```
AI agent (Copilot / Claude) wants to evaluate code
        │
        ├── Option A: MCP tool (direct to aximar-mcp)
        │   evaluate_expression(expression, notebook_id)
        │   → Result in MCP response (AI sees it in chat)
        │   → Does NOT appear in notebook UI
        │
        └── Option B: LM tool (via extension bridge)
            maxima_notebook_run_cell(cellIndex)
            → Extension triggers controller execution
            → Output appears in notebook UI AND returned to AI
```

AI agents have access to both pathways:
- **MCP tools** (via `registerMcpServerDefinitionProvider`): Direct access to
  all 24 aximar-mcp tools. Good for exploration, documentation lookup,
  ad-hoc evaluation.
- **LM tools** (via `vscode.lm.registerTool`): Bridge tools that operate on
  the VS Code notebook UI. Good for modifying the notebook the user is
  looking at.

## Data Flow: Debug Session

```
User clicks "Debug Notebook"
        │
        ▼
Extension (debug.ts)
  1. Read all code cells from active notebook
  2. Concatenate to temp .mac file (tracking cell→line mappings)
  3. vscode.debug.startDebugging({ type: "maxima", program: tempFile })
  4. Register DebugAdapterTracker for source remapping
        │
        ▼
maxima-dap (spawned by VS Code)
  1. Spawns fresh Maxima process (Enhanced or Legacy mode)
  2. Sets deferred breakpoints (Enhanced) or loads then sets (Legacy)
  3. Batchloads temp .mac file — deferred breakpoints resolve
  4. Captures breakpoint resolutions from execution output
  5. Sends breakpoint-changed events with resolved line numbers
        │
        ▼
DebugAdapterTracker (in debug.ts)
  Outgoing: cell URI → temp file path, cell lines → temp lines
  Incoming: temp file → cell URI, temp lines → cell lines
  Breakpoint events matched by ID → cell mapping
        │
        ▼
User interacts via VS Code Debug UI
  - Breakpoints appear inline in notebook cells
  - Step Over (F10), Step Into (F11), Continue (F5)
  - Variables panel, Watch expressions, Call stack
  - Debug console (evaluate expressions at breakpoint)
        │
        ▼
AI can inspect via LM tools
  - maxima_debug_variables → current stack frame variables
  - maxima_debug_evaluate → evaluate in debug context
  - maxima_debug_callstack → stack trace
```

## Extension Activation

The `activate()` function registers all components:

1. Run File command (existing)
2. DAP adapter factory + config provider (existing)
3. Protocol output channel for DAP events (existing)
4. MCP token commands (existing, reworked for shared session)
5. **MCP server provider** (reworked: auto-detect notebook process)
6. **Notebook serializer** (`maxima-notebook` type for `.ipynb`)
7. **Notebook controller** (execution, label tracking, interrupt)
8. **LM tools** (notebook cell ops, debug inspection)
9. **Debug Notebook commands** (Debug Notebook, Debug From Cell)
10. LSP client (existing, updated documentSelector for notebook cells)

## Key Files

| File | Responsibility |
|------|---------------|
| `src/extension.ts` | Activation, registration of all components |
| `src/notebook/serializer.ts` | `.ipynb` ↔ `NotebookData` conversion |
| `src/notebook/controller.ts` | Cell execution, label tracking, output mapping |
| `src/notebook/mcpClient.ts` | aximar-mcp process lifecycle, MCP SDK wrapper |
| `src/notebook/labels.ts` | Label rewriting (`%` and `%oN` resolution) |
| `src/notebook/types.ts` | Shared TypeScript interfaces |
| `src/notebook/lmTools.ts` | AI-facing LM tool implementations |
| `src/notebook/debug.ts` | Debug commands, temp file generation, DAP tracker, AI debug tools |
| `src/renderers/maxima/index.ts` | Custom renderer (KaTeX, Plotly) |
| `src/renderers/maxima/style.css` | Renderer styling |

## Dependencies

| Package | Purpose | Bundle |
|---------|---------|--------|
| `vscode-languageclient` | LSP client | Extension host |
| `@modelcontextprotocol/sdk` | MCP client for aximar-mcp | Extension host |
| `katex` | LaTeX math rendering | Renderer (browser) |
| `plotly.js-dist-min` | Interactive chart rendering | Renderer (browser) |

The extension host and renderer are built as separate bundles by esbuild.
See [renderer.md](renderer.md) for build configuration details.
