# Maxima Notebook for VS Code

VS Code extension for [Maxima](https://maxima.sourceforge.io/), a computer algebra system. Provides syntax highlighting, language server integration, interactive debugging, notebook support, and AI integration.

![Notebook with symbolic math and plots](media/notebook-demo.png)

![Debugger paused at a breakpoint with variable inspection](media/debugger-demo.png)

## Features

The extension has two layers: **built-in features** that work immediately with no extra binaries, and **language tool features** powered by optional Rust binaries from the [aximar](https://github.com/cmsd2/aximar) repository. The extension can auto-download the tools on first use — see [Installation](#installation).

### Built-in (no extra binaries needed)

#### Syntax Highlighting

Full TextMate grammar for Maxima `.mac`, `.max`, and `.wxm` files:

- Keywords: `if`/`then`/`else`, `for`/`do`/`while`, `block`, `lambda`, `catch`/`throw`, `return`, `go`
- Definition operators: `:=` and `::=` (distinct from `:` assignment)
- Function definition sites highlighted at the name
- Statement terminators: `;` (display) and `$` (suppress)
- Built-in constants: `%pi`, `%e`, `%i`, `%phi`, `%gamma`, `inf`, `true`/`false`
- Nested block comments: `/* ... /* inner */ ... */`
- String literals with escape sequences
- `:lisp` escape lines

#### Editor Support

- **Bracket matching** and auto-closing for `()`, `[]`, `{}`, `""`
- **Block comment toggling** (`/* */`)
- **Auto-indentation** after `block(`, `if`, `for`, `while`, `lambda`, etc.
- **Block comment continuation** — pressing Enter inside `/* */` adds ` * ` prefix

#### Run File

Run the current `.mac` file in a terminal via the command palette ("Maxima: Run File"), the editor context menu, or the play button in the editor title bar. Requires Maxima to be installed and on your PATH.

### Language tools (requires aximar binaries)

These features require the Rust binaries from the [aximar](https://github.com/cmsd2/aximar) repository. The extension will prompt to download them automatically if they're not found.

#### Language Server (maxima-lsp)

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

#### Debugger (maxima-dap)

When the `maxima-dap` binary is installed, the extension provides interactive debugging of `.mac` files:

- **Breakpoints** — Set breakpoints on lines inside function definitions
- **Step Over (F10)** — Advance to the next statement in the current function
- **Step Into (F11)** — Step into sub-expressions and function calls
- **Continue (F5)** — Resume execution until the next breakpoint or completion
- **Stack Trace** — View the call stack with source file and line information
- **Variables** — Inspect function arguments and `block()` local variables at each stack frame
- **Debug Console** — Evaluate arbitrary Maxima expressions while stopped at a breakpoint

Requires Maxima with the **SBCL** Lisp backend. See the [maxima-dap documentation](https://github.com/cmsd2/aximar/blob/master/docs/maxima-dap.md) for details and known limitations.

##### Notebook Debugging

Notebooks can also be debugged. The extension writes all code cells to a temporary `.mac` file and launches `maxima-dap` against it:

- **Debug Notebook** — Toolbar button that debugs all cells in order
- **Debug From Cell** — Context menu on a cell to debug from the beginning up to that cell
- **Source mapping** — Breakpoints set in notebook cells are remapped to the temp file and back, so the debug UI shows locations within the original cells
- **Working directory** — The notebook's directory is set as `cwd`, so `load()` and `batchload()` with relative paths work correctly

Note: the debug session runs in a fresh Maxima process (not the notebook's evaluation session), so interactive state from previous cell runs is not available. All function definitions and `load()` calls from cells are re-executed.

#### Notebooks

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

#### Export to HTML / PDF

Export notebooks to self-contained HTML or PDF for sharing and printing. Uses [nbconvert](https://nbconvert.readthedocs.io/) with the [maxima-nbconvert](https://github.com/cmsd2/maxima-nbconvert) package.

- **Export to HTML** — Renders math via MathJax, embeds SVG plots, converts Plotly charts to static SVG
- **Export to PDF** — Produces print-ready PDF via LaTeX (requires xelatex)
- **Command palette** — "Maxima: Export Notebook to HTML" / "Maxima: Export Notebook to PDF"
- **Toolbar buttons** — Available in the notebook toolbar

Requires Python with `maxima-nbconvert` installed in the active environment (detected via the Python extension):

```bash
uv pip install "maxima-nbconvert[plotly]"
```

#### AI Integration

AI agents (Copilot, Claude, etc.) can read and manipulate notebooks via Language Model tools:

- **`maxima_notebook_get_cells`** — Read all cells with source, outputs, and execution state
- **`maxima_notebook_run_cell`** — Execute a cell by index (output appears in the notebook)
- **`maxima_notebook_add_cell`** — Insert a new code cell at any position

The extension also auto-registers the managed `aximar-mcp` process as an MCP server, so AI agents can call `evaluate_expression` directly in the same Maxima session as the notebook. No manual configuration needed — just open a notebook.

## Installation

### Extension

```sh
git clone https://github.com/cmsd2/maxima-notebook.git
cd maxima-notebook
npm install
npm run compile
```

Then either:
- Open the folder in VS Code and press F5 to launch an Extension Development Host
- Or copy the folder to `~/.vscode/extensions/` and restart VS Code

### Language tools (maxima-lsp, maxima-dap, aximar-mcp)

The three Rust binaries are optional but recommended. Without them, you still get syntax highlighting, editor support, and the Run File command. Each tool adds more features:

| Tool | Enables |
|------|---------|
| `maxima-lsp` | Completions, hover, go-to-definition, diagnostics, etc. |
| `maxima-dap` | Interactive debugging with breakpoints and variable inspection |
| `aximar-mcp` | Notebook cell execution and AI integration |

#### Auto-download (recommended)

On first activation, the extension checks for the tools and offers to download pre-built binaries from [GitHub Releases](https://github.com/cmsd2/aximar/releases). You can also trigger this any time from the command palette: **Maxima: Download/Update Tools**.

The extension checks for updates once every 24 hours.

#### Manual: cargo install

If you have a Rust toolchain:

```sh
cargo install --git https://github.com/cmsd2/aximar maxima-lsp maxima-dap aximar-mcp
```

#### Manual: set paths

If you've placed the binaries in a non-standard location, point the extension at them via settings (`maxima.lsp.path`, `maxima.dap.path`, `maxima.notebook.mcpPath`).

### Notebook export (optional)

The export commands require Python with [maxima-nbconvert](https://github.com/cmsd2/maxima-nbconvert) installed. The easiest way is with [uv](https://docs.astral.sh/uv/):

```sh
# Create a virtual environment and install maxima-nbconvert
uv venv
uv pip install "maxima-nbconvert[plotly]"
```

Then select this environment in VS Code: open the command palette and run **Python: Select Interpreter** → **Enter interpreter path…**, and enter `.venv/bin/python` (or `.venv\Scripts\python.exe` on Windows). The export commands will use whichever Python interpreter is selected by the [Python extension](https://marketplace.visualstudio.com/items?itemName=ms-python.python).

The `[plotly]` extra installs Plotly and Kaleido for converting interactive charts to static SVG. Without it, Plotly chart outputs will be skipped during export. PDF export additionally requires a LaTeX distribution (e.g. TeX Live or MiKTeX) for `xelatex`.

### Maxima

Debugging and the Run File command require [Maxima](https://maxima.sourceforge.io/download.html) to be installed separately. The debugger requires the SBCL backend (the default on most installations).

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

## Output channels

The extension provides several output channels (View > Output, then select from the dropdown) for diagnostics and troubleshooting:

| Channel | Contents |
|---------|----------|
| **Maxima Debug Adapter** | Tracing logs from the `maxima-dap` process (DAP lifecycle, breakpoint resolution, Maxima communication) |
| **Maxima Protocol** | Raw Maxima I/O filtered out of the debug console (sentinels, prompts, breakpoint messages) |
| **Maxima Notebook** | Notebook kernel lifecycle (MCP server spawn, connection, tool calls) |
| **Maxima Notebook Debug Tracker** | Source mapping and breakpoint remapping during notebook debug sessions |

## Recommended companion extensions

- **[Unicode Latex](https://marketplace.visualstudio.com/items?itemName=oijaz.unicode-latex)** — Type `\pi` + Tab to insert `π`, `\alpha` + Tab for `α`, etc. Maxima notebooks automatically translate Unicode Greek letters and math symbols to their Maxima equivalents (`π` → `%pi`, `θ` → `theta`), so you can write natural-looking math. Offered as an optional install with this extension.

## Requirements

- **VS Code** 1.99 or later
- **Maxima** (for Run File and debugging) — [download](https://maxima.sourceforge.io/download.html)
- **Language tools** (optional, auto-downloaded) — `maxima-lsp`, `maxima-dap`, `aximar-mcp` from the [aximar](https://github.com/cmsd2/aximar) repository

## License

MIT
