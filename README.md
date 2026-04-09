# Maxima Extension for VS Code

VS Code extension for [Maxima](https://maxima.sourceforge.io/), a computer algebra system. Provides syntax highlighting, language server integration, and a Run File command.

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

## Configuration

Open VS Code settings (Ctrl+, or Cmd+,) and search for "maxima":

| Setting | Default | Description |
|---------|---------|-------------|
| `maxima.lsp.enabled` | `true` | Enable/disable the language server. |
| `maxima.lsp.path` | `""` | Absolute path to the `maxima-lsp` binary. If empty, searches PATH. |

## Requirements

- **VS Code** 1.82 or later
- **Maxima** (for the Run File command) — [download](https://maxima.sourceforge.io/download.html)
- **maxima-lsp** (optional, for language server features) — see installation above

## License

MIT
