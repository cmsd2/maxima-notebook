# Maxima Extension for VS Code

VS Code extension for [Maxima](https://maxima.sourceforge.io/), a computer algebra system. Provides syntax highlighting, language server integration, interactive debugging, notebook support, and AI integration.

## Features

### Syntax Highlighting

Full TextMate grammar for Maxima `.mac`, `.max`, and `.wxm` files:

- Keywords: `if`/`then`/`else`, `for`/`do`/`while`, `block`, `lambda`, `catch`/`throw`, `return`, `go`
- Definition operators: `:=` and `::=` (distinct from `:` assignment)
- Function definition sites highlighted at the name
- Statement terminators: `;` (display) and `$` (suppress)
- Built-in constants: `%pi`, `%e`, `%i`, `%phi`, `%gamma`, `inf`, `true`/`false`
- Nested block comments: `/* ... /* inner */ ... */`
- String literals with escape sequences
- `:lisp` escape lines

### Language Server (maxima-lsp)

When the `maxima-lsp` binary is installed, the extension provides:

- **Completions** — 2500+ built-in functions, package functions, and user-defined symbols
- **Hover documentation** — Signatures, descriptions, examples, and "see also" links
- **Signature help** — Parameter hints as you type inside function calls
- **Go-to-definition** — Jump to where a function or variable is defined
- **Find references** — Locate all uses of a symbol across open files
- **Document symbols** — Outline of functions, macros, and variables (Ctrl+Shift+O)
- **Workspace symbols** — Search all symbols across open files (Ctrl+T)
- **Diagnostics** — Parse errors shown as squiggles in the editor
- **Folding** — Collapse multi-line definitions and block comments

All language server features work offline — no running Maxima process is needed.

### Debugger (maxima-dap)

When the `maxima-dap` binary is installed, the extension provides interactive debugging of `.mac` files:

- **Breakpoints** — Set breakpoints on lines inside function definitions
- **Step Over (F10)** — Advance to the next statement in the current function
- **Step Into (F11)** — Step into sub-expressions and function calls
- **Continue (F5)** — Resume execution until the next breakpoint or completion
- **Stack Trace** — View the call stack with source file and line information
- **Variables** — Inspect function arguments and `block()` local variables at each stack frame
- **Debug Console** — Evaluate arbitrary Maxima expressions while stopped at a breakpoint

Requires Maxima with the **SBCL** Lisp backend. See the [maxima-dap documentation](https://github.com/cmsd2/aximar/blob/master/docs/maxima-dap.md) for details and known limitations.

### Notebooks

Interactive Maxima notebooks with rich output rendering. Create `.macnb` files or open `.ipynb` files with the Maxima kernel.

- **Cell execution** — Run code cells sequentially with per-notebook session isolation
- **KaTeX math** — LaTeX output rendered as typeset math (left-aligned)
- **Plotly charts** — Interactive plots with VS Code theme integration
- **SVG plots** — Native rendering for Maxima's SVG plot output
- **Label rewriting** — Use `%` and `%oN` references across cells
- **New File menu** — "Maxima Notebook" appears in File > New File
- **`.macnb` files** — Default notebook format (opens automatically)
- **`.ipynb` files** — Available via "Open With" picker alongside Jupyter

Requires the `aximar-mcp` binary. The extension spawns and manages the process automatically, using an ephemeral port with bearer token authentication.

### AI Integration

AI agents (Copilot, Claude, etc.) can read and manipulate notebooks via Language Model tools:

- **`maxima_notebook_get_cells`** — Read all cells with source, outputs, and execution state
- **`maxima_notebook_run_cell`** — Execute a cell by index (output appears in the notebook)
- **`maxima_notebook_add_cell`** — Insert a new code cell at any position

The extension also auto-registers the managed `aximar-mcp` process as an MCP server, so AI agents can call `evaluate_expression` directly in the same Maxima session as the notebook. No manual configuration needed — just open a notebook.

### Run File

Run the current `.mac` file in a terminal via the command palette ("Maxima: Run File"), the editor context menu, or the play button in the editor title bar. Requires Maxima to be installed and on your PATH.

## Installation

### From source

```sh
git clone https://github.com/yshl/maxima-extension.git
cd maxima-extension
npm install
npm run compile
```

Then either:
- Open the folder in VS Code and press F5 to launch an Extension Development Host
- Or copy the folder to `~/.vscode/extensions/` and restart VS Code

### Installing maxima-lsp

The language server is optional but recommended. Without it, you still get syntax highlighting and the Run File command.

Build from the [Aximar](https://github.com/cmsd2/aximar) repository:

```sh
git clone https://github.com/cmsd2/aximar.git
cd aximar
cargo install --path crates/maxima-lsp
```

This puts `maxima-lsp` on your PATH. The extension will find it automatically.

### Installing maxima-dap

The debug adapter is optional. Without it, you still get syntax highlighting, language server features, and the Run File command.

Build from the [Aximar](https://github.com/cmsd2/aximar) repository:

```sh
# If you already cloned aximar for maxima-lsp:
cd aximar
cargo install --path crates/maxima-dap
```

This puts `maxima-dap` on your PATH. The extension will find it automatically.

You also need Maxima installed with the SBCL backend (the default on most installations). To verify: `maxima --version` should show a version string, and `maxima --lisp=sbcl -q --batch-string="quit();"` should exit without errors.

### Installing aximar-mcp

The MCP server is required for notebook support. Without it, you still get syntax highlighting, language server features, debugging, and the Run File command.

Build from the [Aximar](https://github.com/cmsd2/aximar) repository:

```sh
# If you already cloned aximar for maxima-lsp:
cd aximar
cargo install --path crates/aximar-mcp
```

This puts `aximar-mcp` on your PATH. The extension spawns it automatically when you execute a notebook cell.

## Configuration

Open VS Code settings (Ctrl+, or Cmd+,) and search for "maxima":

| Setting | Default | Description |
|---------|---------|-------------|
| `maxima.lsp.enabled` | `true` | Enable/disable the language server. |
| `maxima.lsp.path` | `""` | Absolute path to the `maxima-lsp` binary. If empty, searches PATH. |
| `maxima.dap.path` | `""` | Absolute path to the `maxima-dap` binary. If empty, searches PATH. |
| `maxima.maximaPath` | `""` | Absolute path to the Maxima binary. Used by the debugger. If empty, searches PATH. |
| `maxima.notebook.mcpPath` | `""` | Absolute path to the `aximar-mcp` binary. If empty, searches PATH. |
| `maxima.notebook.evalTimeout` | `60` | Cell evaluation timeout in seconds. |

## Requirements

- **VS Code** 1.99 or later
- **Maxima** (for Run File and debugging) — [download](https://maxima.sourceforge.io/download.html)
- **maxima-lsp** (optional, for language server features) — see installation above
- **maxima-dap** (optional, for debugging) — requires Maxima with SBCL backend, see installation above
- **aximar-mcp** (optional, for notebooks) — see installation above

## License

MIT
