# Notebook Roadmap

Phased plan from current state to a polished, debuggable, AI-enabled Maxima
notebook in VS Code.

## Current State

### Working

| Component | File | Status |
|-----------|------|--------|
| Serializer | `src/notebook/serializer.ts` | Complete — ipynb read/write, MIME remapping |
| Controller | `src/notebook/controller.ts` | Complete — emits custom MIME types for all output |
| MCP client | `src/notebook/mcpClient.ts` | Complete — ephemeral port, bearer token auth |
| Labels | `src/notebook/labels.ts` | Complete — ported from aximar-core Rust |
| Types | `src/notebook/types.ts` | Complete |
| LSP in cells | `src/extension.ts` | Working — completions, hover, diagnostics |
| SVG plots | controller | Working — native VS Code renderer |
| Error output | controller | Working — native VS Code error banner |
| KaTeX renderer | `src/renderers/maxima/index.ts` | Complete — LaTeX math rendering |
| Plotly renderer | `src/renderers/maxima/index.ts` | Complete — interactive charts |
| Text renderer | `src/renderers/maxima/index.ts` | Complete — styled text output |
| .macnb support | `package.json` | Complete — default handler for .macnb files |
| New File menu | `package.json` + `extension.ts` | Complete — "Maxima Notebook" in File > New File |

### Known Bugs

- `labelMap` and `executionOrder` are per-controller, not per-notebook —
  two open notebooks share state and collide
- `interruptHandler` not wired to VS Code's interrupt button — shows an
  info message only

### Not Built

| Component | Planned File | Description |
|-----------|-------------|-------------|
| LM tools | `src/notebook/lmTools.ts` | AI bridge tools (`get_cells`, `run_cell`, `add_cell`) |
| Debug integration | `src/notebook/debug.ts` | Write cells to temp file, launch maxima-dap |
| AI debug tools | `src/notebook/lmTools.ts` | Debug inspection tools (`variables`, `evaluate`, `callstack`) |
| Tests | — | Zero test coverage for notebook code |

---

## Phase 1: Foundation (DONE)

Core execution pipeline.

- [x] NotebookSerializer — ipynb read/write
- [x] NotebookController — cell execution, sequential ordering
- [x] McpProcessManager — process lifecycle, MCP SDK client
- [x] Label rewriting — `%` and `%oN` resolution
- [x] LSP in notebook cells — document selector includes `vscode-notebook-cell`
- [x] Ephemeral port + bearer token auth
- [x] Session-per-notebook via MCP `createSession`/`closeSession`

**Result:** Cells execute and produce text output. Functional but unpolished.

---

## Phase 2: Rich Output Rendering (DONE)

Custom notebook renderer with KaTeX, Plotly.js, and styled text output.

- [x] KaTeX renderer — LaTeX math with `preprocessLatex()` ported from Aximar
- [x] Plotly.js renderer — interactive charts with theme integration
- [x] Text output renderer — styled with editor font/colors
- [x] esbuild config for browser-targeted renderer bundle
- [x] Controller emits `application/x-maxima-latex` and `application/x-maxima-plotly`
- [x] Left-aligned LaTeX output (KaTeX default centering overridden)
- [x] Clears previous content on re-render (prevents duplicate plots)
- [x] .macnb registered as default notebook type (Jupyter gets .ipynb as option)
- [x] "Maxima Notebook" appears in File > New File menu

**Result:** Full rich output rendering — typeset math, interactive charts,
styled text. Notebooks are usable for real math work.

---

## Phase 3: Bug Fixes and Polish

Fix known issues and improve robustness.

### 3a: Per-Notebook State

Refactor controller to key `labelMap` and `executionOrder` by notebook URI.

**Work:**
- Replace single `labelMap: Map<number, string>` with
  `notebookState: Map<string, { labelMap, executionOrder }>` keyed by
  notebook URI
- `restartKernel` clears only the target notebook's state
- `onNotebookClose` removes state for the closed notebook

**Acceptance criteria:**
- Two notebooks open simultaneously have independent execution counters
- Restarting one notebook's kernel doesn't affect the other
- Closing a notebook cleans up its state

### 3b: Interrupt Handler

Wire up interrupt to actually stop execution.

**Work:**
- Set `controller.interruptHandler` in the constructor
- Call `mcpManager.restartSession(sessionId)` (Maxima doesn't support
  mid-evaluation interrupt — restart is the only option)
- Cancel any pending `NotebookCellExecution` objects
- VS Code's stop button in the cell toolbar will now work

**Acceptance criteria:**
- Clicking the stop button during a long computation restarts the session
- Pending queued cells are cancelled
- The notebook returns to an editable state

### 3c: Error Handling Improvements

- Show a notification if `aximar-mcp` fails to start (binary not found, etc.)
- Retry logic if the MCP process crashes mid-session
- Timeout on cell execution (use `maxima.notebook.evalTimeout` setting)

---

## Phase 4: AI Integration

Enable VS Code Copilot and other AI agents to read and manipulate notebooks.

### 4a: LM Tools — Notebook Bridge

**File to create:** `src/notebook/lmTools.ts`

**File to modify:** `package.json` — add `contributes.languageModelTools`

Register tools via `vscode.lm.registerTool()`:

| Tool | Input | Description |
|------|-------|-------------|
| `maxima_notebook_get_cells` | `{}` | Read all cells with source and outputs |
| `maxima_notebook_run_cell` | `{ cellIndex }` | Execute a cell, output appears in UI |
| `maxima_notebook_add_cell` | `{ source, afterIndex? }` | Add a code cell to the notebook |

**Acceptance criteria:**
- Copilot can read notebook cells and understand their outputs
- Copilot can add cells and run them, with results visible in the notebook
- Works with the `@workspace` agent context

### 4b: MCP Provider Auto-Detection

Update the MCP server definition provider to auto-detect the notebook's
managed `aximar-mcp` process.

**Work:**
- When `McpProcessManager` starts, expose the URL + token
- MCP provider returns `McpHttpServerDefinition` pointing to the managed
  process (with auth header)
- When the process stops, `mcpChanged.fire()` removes the definition
- Fall back to user-configured settings when no managed process is running

**Acceptance criteria:**
- AI agents automatically discover the notebook's Maxima session
- `evaluate_expression` via MCP runs in the same session as notebook cells
- No manual configuration needed — just open a notebook

---

## Phase 5: Notebook Debugging

Enable debugging Maxima code defined in notebook cells.

### 5a: Debug Notebook Command

**File to create:** `src/notebook/debug.ts`

**Files to modify:**
- `package.json` — add `maxima.notebook.debugNotebook` command + toolbar button
- `src/extension.ts` — register command

**Work:**
1. Concatenate all code cells into a temp `.mac` file with cell markers
2. Track line offset mapping (cell index → start line in temp file)
3. Launch `vscode.debug.startDebugging()` with maxima-dap config
4. Handle cleanup (delete temp file on session end)

**Acceptance criteria:**
- "Debug Notebook" button appears in notebook toolbar
- Breakpoints in function definitions work
- Variables panel shows function args and block locals
- Step over/into/continue work
- Debug console allows evaluating expressions at breakpoints

### 5b: Debug From Cell Command

Add cell-level context menu command that debugs from the start of the
notebook up to and including the selected cell.

**Acceptance criteria:**
- Right-click cell → "Debug From This Cell"
- Only cells up to the selected cell are included in the temp file

### 5c: AI Debug Tools

Add LM tools for AI-assisted debugging.

| Tool | Input | Description |
|------|-------|-------------|
| `maxima_debug_variables` | `{}` | Get variables from current stack frame |
| `maxima_debug_evaluate` | `{ expression }` | Evaluate at breakpoint |
| `maxima_debug_callstack` | `{}` | Get current call stack |

**Acceptance criteria:**
- AI can read variable values during a debug session
- AI can evaluate test expressions at breakpoints
- AI can explain the call chain leading to a breakpoint

---

## Phase 6: Polish and Quality

### 6a: Tests

Add test infrastructure and unit tests for core notebook logic.

**Targets:**
- `labels.ts` — label rewriting with various edge cases
- `serializer.ts` — round-trip ipynb serialization
- `controller.ts` — output mapping logic (mock MCP client)

**Framework:** vitest or mocha + `@vscode/test-electron`

### 6b: Cross-Cell LSP

Implement concat-document middleware so the LSP sees all notebook cells
as a single document.

**What this enables:**
- Function `f(x)` defined in cell 1 completes in cell 3
- Variable assignments flow across cells for hover/diagnostics
- Go-to-definition works across cells

**This is a significant piece of work** — the Jupyter extension's
implementation is complex. Consider whether the value justifies the effort
vs. the 2500+ built-in function completions that already work.

### 6c: Source Mapping for Debug

Use `vscode.debug.registerDebugAdapterTrackerFactory` to translate source
locations from the temp file back to notebook cell URIs, so breakpoints
appear inline in notebook cells rather than in the temp file.

---

## Dependency Graph

```
Phase 1 (DONE)
    │
    ▼
Phase 2 (DONE)
    │
    ▼
Phase 3a (per-notebook state)
Phase 3b (interrupt)
Phase 3c (error handling)
    │
    ├──► Phase 4a (LM tools) ──► Phase 4b (MCP auto-detect)
    │
    └──► Phase 5a (debug notebook) ──► Phase 5b (debug from cell)
                                   ──► Phase 5c (AI debug tools)
    │
    ▼
Phase 6a (tests)
Phase 6b (cross-cell LSP)
Phase 6c (debug source mapping)
```

Phases 2, 3, 4, and 5 can proceed somewhat in parallel — 2 and 3 have
no dependency on 4 or 5. Phase 6 depends on all prior phases being stable.

---

## Estimated Effort

| Phase | Effort | Cumulative |
|-------|--------|------------|
| 1. Foundation | DONE | — |
| 2. Rich output rendering | DONE | — |
| 3. Bug fixes + polish | 2-3 days | 2-3 days |
| 4. AI integration | 3-4 days | 5-7 days |
| 5. Debugging | 4-5 days | 9-12 days |
| 6. Polish + quality | 5-7 days | 14-19 days |
