# Change Log

## [Unreleased]
### Added

### Changed

### Fixed

## [0.2.1]
### Fixed
- "Restart Language Server" and "Search Documentation" commands no longer fail with "command not found" when the maxima-lsp binary was not yet available at activation time

## [0.2.0]
### Added
- Debug adapter logs now appear in the "Maxima Debug Adapter" output channel instead of writing to `/tmp/maxima-dap.log`
- Screenshots on the marketplace page showing notebook and debugger features
- Copilot code generation instructions for Maxima syntax (comma/ev, terminators, Unicode Greek, plotting)
- Recommend [Unicode Latex](https://marketplace.visualstudio.com/items?itemName=oijaz.unicode-latex) extension for typing Greek letters and math symbols
- LM tool descriptions updated with Maxima syntax tips

### Fixed
- SVG plots from gnuplot no longer waste vertical space — fixed dimensions are replaced with responsive sizing
- Source mapping: negative cell line numbers no longer occur when the debugger stops on a line before a cell's range
- Notebook debugging: breakpoints in unsaved (untitled) notebooks are now preserved when the notebook is saved at debug launch time. The extension saves the notebook before generating the temp file and migrates breakpoints from old untitled cell URIs to new file-backed cell URIs automatically.

## [0.1.0]
### Added
- Language server client for `maxima-lsp` — completions, hover, signature help, go-to-definition, find references, document/workspace symbols, diagnostics, folding
- "Maxima: Run File" command (command palette, context menu, editor title bar)
- Settings: `maxima.lsp.enabled`, `maxima.lsp.path`
- TypeScript build system with esbuild

### Changed
- Enhanced TextMate grammar: `:=`/`::=` definition operators, `block`/`lambda`/`catch`/`throw`/`error`/`errcatch` keywords, statement terminators (`;`/`$`), `:lisp` escape, function definition site highlighting
- Fixed identifier patterns to include `_`, `%`, `?` characters
- Standardized scope names (`entity.name.function.call`, `variable.other`)
- Added `wordPattern`, indentation rules, and comment continuation to language configuration
- Bumped minimum VS Code version to 1.82

## [0.0.2]
### Changed
- Added publisher to package.json

## [0.0.1]
### Added
- Syntax highlighting
