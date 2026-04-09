# Change Log

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
