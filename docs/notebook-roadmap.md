# Notebook Roadmap

Phased plan from current state to a polished, debuggable, AI-enabled Maxima
notebook in VS Code.

## Current State

### Working

| Component | File | Status |
|-----------|------|--------|
| Serializer | `src/notebook/serializer.ts` | Complete — ipynb read/write, MIME remapping |
| Controller | `src/notebook/controller.ts` | Complete — per-notebook state, eval timeout, crash recovery |
| MCP client | `src/notebook/mcpClient.ts` | Complete — ephemeral port, bearer token auth, generation tracking |
| Labels | `src/notebook/labels.ts` | Complete — ported from aximar-core Rust |
| Types | `src/notebook/types.ts` | Complete |
| LSP in cells | `src/extension.ts` | Working — completions, hover, diagnostics |
| SVG plots | controller | Working — native VS Code renderer |
| Error output | controller | Working — native VS Code error banner |
| KaTeX renderer | `src/renderers/maxima/index.ts` | Complete — LaTeX math rendering (fleqn left-aligned) |
| Plotly renderer | `src/renderers/maxima/index.ts` | Complete — interactive charts |
| Text renderer | `src/renderers/maxima/index.ts` | Complete — styled text output |
| .macnb support | `package.json` | Complete — default handler for .macnb files |
| .ipynb support | `package.json` | Complete — "Open With" option via compat notebook type |
| New File menu | `package.json` + `extension.ts` | Complete — "Maxima Notebook" in File > New File |
| LM tools | `src/notebook/lmTools.ts` | Complete — get_cells, run_cell, add_cell for AI agents |
| MCP auto-detect | `src/extension.ts` | Complete — managed process auto-discovered by AI agents |

### Known Bugs

- `interruptHandler` not wired to VS Code's interrupt button — shows an
  info message only (restart-based interrupt deferred — too destructive)

### Not Built

| Component | Planned File | Description |
|-----------|-------------|-------------|
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
- [x] Left-aligned LaTeX output via KaTeX `fleqn` option
- [x] Clears previous content on re-render (prevents duplicate plots)
- [x] .macnb registered as default notebook type
- [x] .ipynb available via "Open With" (separate `maxima-notebook-compat` type)
- [x] "Maxima Notebook" appears in File > New File menu

**Result:** Full rich output rendering — typeset math, interactive charts,
styled text. Notebooks are usable for real math work.

---

## Phase 3: Bug Fixes and Polish (DONE)

Fix known issues and improve robustness.

### 3a: Per-Notebook State (DONE)

- [x] Replaced shared `executionOrder`/`labelMap` with per-notebook
  `notebookState: Map<string, NotebookState>` keyed by notebook URI
- [x] `restartKernel` clears only the target notebook's state
- [x] `onNotebookClose` removes state for the closed notebook

### 3b: Interrupt Handler (DEFERRED)

Restart-based interrupt is too destructive — kills all session state.
Deferred until `aximar-mcp` supports a proper cancel signal.

### 3c: Error Handling Improvements (DONE)

- [x] Notification with "Open Settings" action if `aximar-mcp` fails to
  start (binary not found, connection failure)
- [x] Stale session recovery via generation counter on `McpProcessManager` —
  after a crash and respawn, old session IDs are detected and replaced
- [x] Cell evaluation timeout using `maxima.notebook.evalTimeout` setting
  (default 60s)

---

## Phase 4: AI Integration (DONE)

Enable VS Code Copilot and other AI agents to read and manipulate notebooks.

### 4a: LM Tools — Notebook Bridge (DONE)

- [x] `src/notebook/lmTools.ts` — three tools registered via `vscode.lm.registerTool()`
- [x] `maxima_notebook_get_cells` — reads all cells with source, outputs (text/latex/plot flags/errors)
- [x] `maxima_notebook_run_cell` — executes cell by index via `executeCellByIndex()`, with confirmation
- [x] `maxima_notebook_add_cell` — inserts code cell at position, with confirmation and code preview
- [x] `package.json` — `contributes.languageModelTools` with input schemas
- [x] `controller.ts` — public `executeCellByIndex()` for programmatic execution

### 4b: MCP Provider Auto-Detection (DONE)

- [x] `McpProcessManager` exposes `getToken()` and `onDidChangeRunning` event
- [x] MCP provider returns auto-detected "Maxima Notebook" definition when
  managed process is running (alongside user-configured servers)
- [x] `resolveMcpServerDefinition` injects ephemeral token for managed process
- [x] `onDidChangeRunning` fires `mcpChanged` to update server list on start/stop

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
Phase 3 (DONE) — per-notebook state, error handling
    │
    ├──► Phase 4 (DONE) — LM tools, MCP auto-detect
    │
    └──► Phase 5a (debug notebook) ──► Phase 5b (debug from cell)
                                   ──► Phase 5c (AI debug tools)
    │
    ▼
Phase 6a (tests)
Phase 6b (cross-cell LSP)
Phase 6c (debug source mapping)
```

Phase 6 depends on all prior phases being stable.

---

## Estimated Effort

| Phase | Effort | Cumulative |
|-------|--------|------------|
| 1. Foundation | DONE | — |
| 2. Rich output rendering | DONE | — |
| 3. Bug fixes + polish | DONE | — |
| 4. AI integration | DONE | — |
| 5. Debugging | 4-5 days | 4-5 days |
| 6. Polish + quality | 5-7 days | 9-12 days |
