# Notebook Debugging

Debugging Maxima code in notebook cells and loaded `.mac` files.

## Overview

Maxima supports breakpoints inside function bodies (and nowhere else). The
existing DAP integration (`maxima-dap`) provides breakpoints, stepping,
variable inspection, and a debug console for `.mac` files.

Notebook debugging extends this to notebook cells by writing cell code to a
temporary `.mac` file and launching `maxima-dap` against it. This gives users
the full DAP experience (breakpoints, step over/into, variables panel, call
stack) for functions defined in notebook cells and in files loaded via
`load()`.

## Architecture

```
Notebook cells                    External .mac files
┌──────────────┐                 ┌──────────────────┐
│ Cell 1: f(x) │                 │ mylib.mac        │
│ Cell 2: g(x) │                 │  h(x) := ...     │
│ Cell 3: g(5) │                 │  k(x) := ...     │
└──────┬───────┘                 └──────────────────┘
       │                                   │
       ▼                                   │
  Write to temp file                       │
  __maxima_notebook_debug.mac              │
  ┌────────────────────────────┐           │
  │ /* Cell 1 */               │           │
  │ f(x) := block([y],        │           │
  │   y: x^2,                 │           │
  │   y + 1                   │           │
  │ );                         │           │
  │ /* Cell 2 */               │           │
  │ g(x) := f(x) * 2;         │           │
  │ /* Cell 3 */               │           │
  │ load("mylib.mac");  ───────┼───────────┘
  │ g(5);                      │
  └────────────┬───────────────┘
               │
               ▼
         maxima-dap
         (spawns fresh Maxima)
         - batchloads temp file
         - sets breakpoints in functions
         - loads mylib.mac (via load() in temp file)
         - breakpoints in mylib.mac work
               │
               ▼
         VS Code Debug UI
         - Breakpoints panel
         - Variables panel
         - Call stack
         - Debug console
```

## Commands

### Debug Notebook

**Command:** `maxima.notebook.debugNotebook`
**Location:** Notebook toolbar button
**Keyboard:** None (toolbar only)

Writes ALL code cells to a temp file and launches a debug session.

1. Get all code cells from the active notebook in order
2. Concatenate source code into `__maxima_notebook_debug.mac`
3. Insert cell markers as comments: `/* Cell N (line M) */`
4. Track line offset mapping: cell index → start line in temp file
5. Launch debug: `vscode.debug.startDebugging(folder, config)`
   ```json
   {
     "type": "maxima",
     "request": "launch",
     "name": "Debug Notebook",
     "program": "/tmp/__maxima_notebook_debug.mac",
     "stopOnEntry": false
   }
   ```

### Debug From Cell

**Command:** `maxima.notebook.debugFromCell`
**Location:** Cell title context menu
**Use case:** Debug a specific section without running the whole notebook

Same as Debug Notebook but only includes cells from the beginning up to and
including the selected cell. Useful when a notebook has many cells and the
user only wants to debug a function defined early on.

## Temp File Format

The generated temp file looks like:

```maxima
/* === Maxima Notebook Debug === */
/* Generated from: MyNotebook.ipynb */

/* Cell 1 (line 4) */
f(x) := block([y],
  y: x^2,
  y + 1
);

/* Cell 2 (line 10) */
g(x) := f(x) * 2;

/* Cell 3 (line 13) */
load("mylib.mac");
g(5);
```

Cell markers include the cell index and the starting line number for
debugging reference.

## Debugger Modes

maxima-dap supports two modes, detected automatically at launch:

| Mode | Detection | Breakpoint style |
|------|-----------|-----------------|
| **Enhanced** | Patched Maxima with `set_breakpoint` function | `:break "file.mac" LINE` — file:line breakpoints with deferred resolution |
| **Legacy** | Stock Maxima | `:break func offset` — function+offset breakpoints |

Enhanced mode is the recommended path. It supports **deferred breakpoints**
(set before the file is loaded, resolved during `batchload`), line-snapping,
and canonical file paths for stack frames.

### Breakpoint resolution

When Enhanced Maxima resolves a deferred breakpoint, it prints a message
with the full file path:

```
Bkpt 0 for $g (in /Users/chris/debug.mac line 2)
```

maxima-dap captures these resolution messages from execution output (during
`batchload`, `:resume`, `:next`, `:step`) and matches them back to the
stored DAP breakpoints by file path and line proximity. This avoids a
separate `:info :bkpt` query and provides exact file matching (no suffix
heuristics).

## What Works

### Breakpoints in Function Definitions

Maxima supports breakpoints inside `block()` bodies. Users set breakpoints
in notebook cells (or in loaded `.mac` files) on lines inside function
definitions.

```maxima
f(x) := block([y],
  y: x^2,         /* ← breakpoint here */
  y + 1
);
```

When `f()` is called, execution stops at the breakpoint. The user sees:
- **Variables panel:** Function arguments (`x`) and block locals (`y`)
- **Call stack:** Frame showing `f(x)` with the source location
- **Debug console:** Evaluate expressions at the breakpoint

### Breakpoints in Loaded Files

If a notebook cell does `load("mylib.mac")`, any functions in `mylib.mac`
are loaded into the Maxima session. Users set breakpoints in `mylib.mac`
directly (it's a regular `.mac` file), and those breakpoints fire when the
functions are called from the temp file.

In Enhanced mode, breakpoints in loaded files use deferred resolution —
they are set before `batchload` and resolve when Maxima loads the file.

### Stepping

| Action | Shortcut | Description |
|--------|----------|-------------|
| Continue | F5 | Run to next breakpoint |
| Step Over | F10 | Execute current statement, skip function bodies |
| Step Into | F11 | Enter function calls |

Step Out is not supported (Maxima debugger limitation).

### Debug Console

The debug console allows evaluating expressions at the current breakpoint.
This uses maxima-dap's evaluate handler, which runs expressions in the
Maxima debugger context.

### Debug Restart

The debug session can be restarted (toolbar button or F5 after termination).
On restart:
- The temp file is regenerated from the current notebook cells (picking up edits)
- The cell line mappings are refreshed
- A new Maxima process is spawned, but the debug UI stays in the same session

## Source Mapping

A `DebugAdapterTracker` intercepts DAP messages to remap source locations
between notebook cell URIs and the temp `.mac` file.

### Outgoing (VS Code → adapter)

- `setBreakpoints` for a notebook cell URI → rewrites source path to the
  temp file and converts cell-relative line numbers to temp-file lines

### Incoming (adapter → VS Code)

- `setBreakpoints` response → rewrites source paths back to cell URIs,
  converts temp-file lines back to cell-relative lines
- `stackTrace` response → rewrites frame sources to cell URIs
- `breakpoint` event (e.g. deferred breakpoint verified) → rewrites to
  cell URI using the stored breakpoint-ID-to-cell mapping

### Breakpoint ID tracking

The tracker maintains:
- `breakpointIdToMapping` — maps DAP breakpoint ID → cell mapping, so
  breakpoint-changed events always find the right cell
- `breakpointIdToCellLine` — maps DAP breakpoint ID → original cell-relative
  line (from the setBreakpoints response), used as the authoritative line
  for breakpoint events

This means breakpoints appear inline in notebook cells. When stepping into
a loaded `.mac` file, the stack trace shows the `.mac` file directly (no
remapping needed).

### Unrelated notebook cells

When a user has breakpoints set in cells from a different notebook (or
non-code cells), the tracker clears those breakpoint requests to prevent
cross-notebook interference with deferred breakpoint matching.

## Limitations

### Separate Maxima Process

The debug session spawns a fresh Maxima process via `maxima-dap`. This is
**not** the notebook's evaluation session (which runs in aximar-mcp).

Implications:
- All function definitions from cells are re-executed (they're in the
  temp file), so functions are available
- `load()` calls in cells are re-executed, so loaded files are available
- Interactive state (variables set by previous cell runs in the notebook)
  is NOT available — the debug Maxima starts fresh
- This is acceptable because debugging is about stepping through function
  logic, not reproducing interactive session state

### Breakpoint Locations

Maxima only supports breakpoints inside function `block()` bodies. You
cannot set breakpoints on:
- Top-level statements (outside functions)
- `load()` calls themselves
- Inside `if`/`for` constructs that aren't in a `block()`

maxima-dap handles this gracefully — breakpoints on unsupported lines are
marked as "unverified."

## AI Debug Tools

AI agents can inspect the debug session via LM tools registered with
`vscode.lm.registerTool()`.

### `maxima_debug_variables`

Returns variables from the current stack frame.

**Implementation:**
```typescript
async invoke(options, token) {
  const session = vscode.debug.activeDebugSession;
  if (!session || session.type !== "maxima") {
    return new LanguageModelToolResult([
      new LanguageModelTextPart("No active Maxima debug session")
    ]);
  }

  // Get top stack frame
  const stack = await session.customRequest("stackTrace", { threadId: 1 });
  const topFrame = stack.stackFrames[0];

  // Get scopes (locals, arguments)
  const scopes = await session.customRequest("scopes", {
    frameId: topFrame.id
  });

  // Get variables for each scope
  const results = [];
  for (const scope of scopes.scopes) {
    const vars = await session.customRequest("variables", {
      variablesReference: scope.variablesReference
    });
    results.push({ scope: scope.name, variables: vars.variables });
  }

  return new LanguageModelToolResult([
    new LanguageModelTextPart(JSON.stringify(results))
  ]);
}
```

### `maxima_debug_evaluate`

Evaluates an expression in the current debug context.

**Input:** `{ expression: string }`

**Implementation:**
```typescript
const result = await session.customRequest("evaluate", {
  expression: options.input.expression,
  context: "repl",
  frameId: topFrame.id
});
return new LanguageModelToolResult([
  new LanguageModelTextPart(result.result)
]);
```

### `maxima_debug_callstack`

Returns the current call stack with frame information.

**Implementation:**
```typescript
const stack = await session.customRequest("stackTrace", { threadId: 1 });
return new LanguageModelToolResult([
  new LanguageModelTextPart(JSON.stringify(stack.stackFrames.map(f => ({
    name: f.name,
    source: f.source?.path,
    line: f.line
  }))))
]);
```

## Unsaved (Untitled) Notebooks

When debugging an unsaved notebook, VS Code needs stable file-backed cell URIs
so breakpoints can be correctly mapped to the temp `.mac` file. The extension
handles this automatically:

1. User sets breakpoints in cells of an untitled notebook
2. User clicks "Debug Notebook"
3. The extension calls `vscode.workspace.save()` before generating the temp
   file — VS Code shows a Save As dialog
4. After saving, the notebook URI changes from `untitled:Untitled-1.macnb` to
   `file:///path/to/saved.macnb`, and all cell URIs change accordingly
5. Orphaned breakpoints (still referencing old untitled cell URIs) are
   automatically migrated to the new file-backed cell URIs
6. The temp file is generated using the new stable cell URIs
7. The debug session starts normally

### Breakpoint migration

The `migrateOrphanedBreakpoints()` function runs at debug launch time for
previously-untitled notebooks. It:

- Collects cell URIs from all currently-open notebooks
- Finds breakpoints on `vscode-notebook-cell:` URIs that don't match any open
  notebook (orphaned)
- Groups orphaned breakpoints by notebook prefix
- Only migrates groups from untitled notebooks (detected by the absence of a
  leading `/` after the `vscode-notebook-cell:` scheme)
- Maps old cell URIs to new cell URIs by index order (cell order is preserved
  across save)

This avoids accidentally stealing breakpoints from other closed file-backed
notebooks.

## Example Debug Workflow

1. User has a notebook with:
   - Cell 1: `f(x) := block([y], y: x^2, y + 1);`
   - Cell 2: `g(x) := f(x) * 2;`
   - Cell 3: `g(5);`
2. User opens the temp file (or sets breakpoints before running Debug)
3. User sets a breakpoint inside `f` at `y: x^2`
4. User clicks "Debug Notebook" in the toolbar
5. maxima-dap loads the temp file, calls `g(5)` which calls `f(5)`
6. Execution stops at the breakpoint
7. Variables panel shows: `x = 5`, `y = (not yet assigned)`
8. User steps over → `y = 25`
9. User steps over → function returns `26`
10. User continues → `g(5)` returns `52`
11. Debug session ends

With AI assistance:
- AI calls `maxima_debug_variables` → `[{scope: "Arguments", variables: [{name: "x", value: "5"}]}, {scope: "Locals", variables: [{name: "y", value: "25"}]}]`
- AI calls `maxima_debug_evaluate("y^2")` → `"625"`
- AI explains: "The function computes x^2 + 1. With x=5, y=25, result is 26."
