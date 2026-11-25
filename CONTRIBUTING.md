# Contributing

Thank you for your interest in contributing to the Maxima VS Code extension! This guide covers how to report issues, submit changes, and set up the project for local development.

## Reporting Issues

- Search [existing issues](https://github.com/cmsd2/maxima-notebook/issues) before opening a new one.
- Include the VS Code version, extension version, and OS.
- For language server or debugger issues, include the relevant output channel logs (View > Output, then select "Maxima Language Server", "Maxima Protocol", or "Maxima Notebook" from the dropdown).
- If the problem involves specific Maxima code, include a minimal reproducing example.

## Submitting Changes

1. Fork the repository and create a branch from `main`.
2. Make your changes. Run `npm run lint` to type-check before committing.
3. Write a clear commit message describing what changed and why.
4. Open a pull request against `main`. Describe what the PR does and link any related issues.
5. Keep PRs focused — one logical change per PR makes review easier.

For larger changes (new features, architectural changes), please open an issue first to discuss the approach before investing significant effort.

## Language Tools (Rust)

The Rust binaries (`maxima-lsp`, `maxima-dap`, `aximar-mcp`) live in the separate [aximar](https://github.com/cmsd2/aximar) repository. If you know your issue or change relates to those tools, please file it there. If you're not sure which repo is responsible, filing it here is fine — we'll triage it to the right place.

## Project Structure

```
maxima-notebook/
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
git clone https://github.com/cmsd2/maxima-notebook.git
cd maxima-notebook
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

1. Open the `maxima-notebook` folder in VS Code.
2. Press **F5** to launch an Extension Development Host window.
   - This runs `npm run compile` automatically, then opens a new VS Code window with the extension loaded.
3. Open any `.mac` file in the dev host to test syntax highlighting, commands, and LSP features.
4. After making changes, press **Ctrl+Shift+F5** (or Cmd+Shift+F5) to reload the dev host.

### Test against a particular build of the tools

`scripts/dev-env.py` opens a development host with its own VS Code profile, set up to use a chosen build of maxima-lsp, maxima-dap and aximar-mcp. Your own profile, settings and extensions stay untouched.

```sh
scripts/dev-env.py --tools latest                                # newest tools release
scripts/dev-env.py --tools tools-v0.5.0                          # a release
scripts/dev-env.py --tools ~/src/aximar                          # build a checkout
scripts/dev-env.py --tools git:origin/master+pr:45 --open ~/proj # master with PR 45 merged
scripts/dev-env.py --list                                        # cached profiles and builds
```

`git:` specs need the aximar repository: a sibling checkout, `$AXIMAR_REPO`, or `--aximar-repo`. Builds are cached by commit, so a second run with the same refs starts at once. Profiles keep their state between runs unless you pass `--fresh`. See `scripts/dev-env.py --help` for every option.

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

## Code Style

- TypeScript with strict mode enabled. Run `npm run lint` (`tsc --noEmit`) to check.
- Use the existing code as a guide for formatting and naming conventions.
- Prefer simple, readable code over clever abstractions.
- Before committing, `npm run lint` (`tsc`) and `npm test` must pass with no errors or warnings. No formatter is enforced; match the style of the surrounding code.

## Packaging

To build a `.vsix` package for distribution:

```sh
npx @vscode/vsce package
```

This runs `npm run package` (production esbuild), then packages the result. The `.vscodeignore` file controls what is included — source files, node_modules, and build config are excluded.

## Releasing

Versions follow VS Code's convention for pre-releases: an odd minor version (0.5.x) is a pre-release, an even one (0.6.x) a stable release. Users opt in to pre-releases with "Switch to Pre-Release Version" on the extension's page, and always get the highest version, so a stable release overtakes the pre-releases before it.

1. Set the version in `package.json` (`npm install --package-lock-only` updates the lockfile) and turn the changelog's Unreleased section into that version.
2. Merge, then tag the merge commit `v<version>` and push the tag.
3. Publish from that commit:

   ```sh
   npx @vscode/vsce publish --pre-release   # odd minor
   npx @vscode/vsce publish                 # even minor
   ```

The extension needs the aximar tools release named by `MIN_TOOLS_VERSION` (`src/toolsVersion.ts`); release the tools first.
