# Contributing

## Project Structure

```
maxima-extension/
├── src/
│   └── extension.ts              # Entry point: LSP client + Run File command
├── syntaxes/
│   └── maxima.tmLanguage.json    # TextMate grammar for syntax highlighting
├── language-configuration.json   # Brackets, comments, word pattern, indentation
├── package.json                  # Extension manifest, commands, settings, dependencies
├── tsconfig.json                 # TypeScript configuration
├── esbuild.mjs                  # Bundler: compiles src/ → out/extension.js
├── .vscode/
│   ├── launch.json               # F5 debug launch config
│   └── tasks.json                # Compile and watch tasks
└── out/
    └── extension.js              # Build output (git-ignored)
```

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [VS Code](https://code.visualstudio.com/) 1.82+
- [Rust toolchain](https://rustup.rs/) (to build maxima-lsp)

## Setup

```sh
git clone https://github.com/yshl/maxima-extension.git
cd maxima-extension
npm install
npm run compile
```

## Development Workflow

### Build

```sh
npm run compile          # One-shot build
npm run watch            # Rebuild on file changes
npm run lint             # Type-check without emitting (tsc --noEmit)
npm run package          # Production build (minified, no source maps)
```

### Test in VS Code

1. Open the `maxima-extension` folder in VS Code.
2. Press **F5** to launch an Extension Development Host window.
   - This runs `npm run compile` automatically, then opens a new VS Code window with the extension loaded.
3. Open any `.mac` file in the dev host to test syntax highlighting, commands, and LSP features.
4. After making changes, press **Ctrl+Shift+F5** (or Cmd+Shift+F5) to reload the dev host.

### Testing with maxima-lsp

To test language server features, build and install `maxima-lsp` from the Aximar repo:

```sh
cd /path/to/aximar
cargo install --path crates/maxima-lsp
```

Or point the extension at a debug build via the `maxima.lsp.path` setting:

```json
{
  "maxima.lsp.path": "/path/to/aximar/target/debug/maxima-lsp"
}
```

To see LSP server logs, check the "Maxima Language Server" output channel in the dev host (View > Output > select "Maxima Language Server" from the dropdown). For more verbose logs, set the `RUST_LOG` environment variable before launching VS Code:

```sh
RUST_LOG=debug code .
```

## Architecture

### Extension Entry Point (src/extension.ts)

`activate()` does two things:

1. **Registers the "Maxima: Run File" command** — saves the active file, opens a terminal, and runs `maxima --very-quiet --batch "<file>"`.

2. **Starts the LSP client** — reads `maxima.lsp.enabled` and `maxima.lsp.path` from settings, spawns the `maxima-lsp` binary over stdio, and connects `vscode-languageclient`. If the binary isn't found, it shows a warning and the extension continues without language server features.

`deactivate()` stops the LSP client.

### TextMate Grammar (syntaxes/maxima.tmLanguage.json)

Pattern matching order matters — the `patterns` array at the top of the grammar controls priority:

1. **Comments** — prevents anything inside `/* */` from matching as code
2. **Strings** — same for quoted content
3. **`:lisp` escape** — switches scope for the rest of the line
4. **Function definitions** — `f(x) :=` captures the name distinctly
5. **Definition operators** — `:=` and `::=` before generic operator matching
6. **Terminators** — `;` and `$`
7. **Keywords** — control flow, logical operators, `load`, `define`
8. **Constants** — numeric literals and language constants (`%pi`, etc.)
9. **Functions** — identifiers followed by `(`
10. **Variables** — remaining identifiers

### Language Configuration (language-configuration.json)

- `wordPattern` defines what counts as a "word" for double-click, Ctrl+D, and word-based completions. Matches Maxima identifiers: letters, digits, `_`, `%`, `?`.
- `indentationRules` auto-indent after `block(`, `if ... then`, etc.
- `onEnterRules` continue `/* */` block comments with ` * ` prefixes.

## Making Changes

### Adding a new command

1. Add the command to `contributes.commands` in `package.json`.
2. Add menu entries under `contributes.menus` with appropriate `when` clauses.
3. Register the command handler in `src/extension.ts` inside `activate()`.

### Modifying the grammar

Edit `syntaxes/maxima.tmLanguage.json`. Test changes by pressing F5 and opening a `.mac` file. Use "Developer: Inspect Editor Tokens and Scopes" (from the command palette in the dev host) to verify that tokens get the expected scopes.

### Adding a new setting

1. Add the property under `contributes.configuration.properties` in `package.json`.
2. Read it in `src/extension.ts` via `vscode.workspace.getConfiguration("maxima")`.

## Packaging

To build a `.vsix` package for distribution:

```sh
npx @vscode/vsce package
```

This runs `npm run package` (production esbuild), then packages the result. The `.vscodeignore` file controls what is included — source files, node_modules, and build config are excluded.
