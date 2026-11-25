# Change Log

## [Unreleased]
### Added
- Animated plots from ax-plots' `animate(...)` play in notebooks, with a slider and play/pause controls. The axes stay fixed across frames, and lines keep every point, so the animation doesn't jitter or tear
- The extension checks that aximar-mcp supports notebook cells and offers to update it when it doesn't; after an update, the next cell run uses the new version
- Unit tests, and tests of the MCP client against real aximar-mcp builds (`npm test`)
- Notebook files are read and written by `aximar-notebook-format`, the code Aximar uses, so both write the same files: every cell has an nbformat 4.5 `id`, kept across saves, and new and pasted cells get their own
- Raw cells open as text and are saved unchanged (they were dropped)
- A result's `text/plain` is its one-line form (`x^2/2`), with tools that send it

### Changed
- aximar-mcp numbers cell runs and resolves `%oN` and `%`, as in the Aximar window; the extension sends each cell's ID and the IDs of the cells above it. Needs Maxima tools 0.6.0 or later
- Downloading the tools refuses releases older than 0.6.0
- Cells no longer store `outputLabel` and `executionCount` metadata; running a cell removes them

### Fixed
- A notebook saved by v0.3.0 or earlier no longer keeps each result's LaTeX as its `text/plain` (aximar-notebook-format 0.1.2)
- A plot's `text/plain` is a description (`<SVG plot>`) instead of a copy of the plot's source, which Aximar showed as text
- Error outputs read from a file show their message without the extension's stack trace
- A file that isn't a notebook fails to open instead of opening empty, where saving would overwrite it
- `%o1` and `%` work again with tools that include aximar#70
- Downloading or updating the tools restarts aximar-mcp, so notebooks use the new version
- Changing `maxima.notebook.mcpPath` takes effect on the next cell run instead of after a reload
- "Install with cargo" builds from Aximar's lockfile and replaces tools already in `~/.cargo/bin` (it failed with "binary already exists in destination", or on newer dependencies)

## [0.3.0]
### Added
- "Export Notebook to HTML" and "Export Notebook to PDF" commands — uses [maxima-nbconvert](https://github.com/cmsd2/maxima-nbconvert) and nbconvert under the hood
- Notebook toolbar buttons for export
- Python interpreter discovery via the VS Code Python extension API, with fallback to `python3` on PATH

## [0.2.2]
### Fixed
- Fix "Cannot access before initialization" error when tools are downloaded after extension activation

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
