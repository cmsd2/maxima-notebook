# Maxima Extension for VS Code

VS Code extension for [Maxima](https://maxima.sourceforge.io/), a computer algebra system. Provides syntax highlighting, language server integration, interactive debugging, and a Run File command.

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

### MCP Server

The extension can register a [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server so that VS Code, Copilot, and other AI agents can discover and use Maxima tools.

1. Set `maxima.mcp.enabled` to `true` in VS Code settings.
2. Choose a transport:
   - **HTTP** (default) — the extension connects to a running MCP server at the configured URL.
   - **stdio** — the extension launches a local binary and communicates over stdin/stdout.
3. If the server requires authentication, run the **Maxima: Set MCP Token** command from the command palette. The token is stored securely in your OS keychain and sent as a `Bearer` token in the `Authorization` header (HTTP transport only).

To remove a stored token, run **Maxima: Clear MCP Token**.

To verify the server is registered and start it, run **MCP: List Servers** from the command palette. "Maxima MCP" should appear in the list. Select it and click **Start** to activate the connection.

## Configuration

Open VS Code settings (Ctrl+, or Cmd+,) and search for "maxima":

| Setting | Default | Description |
|---------|---------|-------------|
| `maxima.lsp.enabled` | `true` | Enable/disable the language server. |
| `maxima.lsp.path` | `""` | Absolute path to the `maxima-lsp` binary. If empty, searches PATH. |
| `maxima.dap.path` | `""` | Absolute path to the `maxima-dap` binary. If empty, searches PATH. |
| `maxima.mcp.enabled` | `false` | Enable the MCP server. |
| `maxima.mcp.transport` | `"http"` | Transport: `"http"` or `"stdio"`. |
| `maxima.mcp.url` | `"http://localhost:8000/mcp"` | URL of the MCP server (HTTP transport). |
| `maxima.mcp.path` | `""` | Absolute path to the MCP tool binary (stdio transport). |
| `maxima.mcp.args` | `[]` | Command-line arguments for the MCP tool (stdio transport). |

## Requirements

- **VS Code** 1.99 or later
- **Maxima** (for Run File and debugging) — [download](https://maxima.sourceforge.io/download.html)
- **maxima-lsp** (optional, for language server features) — see installation above
- **maxima-dap** (optional, for debugging) — requires Maxima with SBCL backend, see installation above

## License

MIT
