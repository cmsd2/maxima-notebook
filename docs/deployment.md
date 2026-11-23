# Deployment

## Architecture

The Maxima VS Code extension consists of three components:

1. **Extension** (TypeScript, MIT) — VS Code extension providing syntax highlighting, notebook support, and integration glue.
2. **Language tools** (Rust, GPL-3.0-or-later) — Three standalone binaries from the [aximar](https://github.com/cmsd2/aximar) repository:
   - `maxima-lsp` — Language Server Protocol server for completions, hover, diagnostics
   - `maxima-dap` — Debug Adapter Protocol server for step debugging
   - `aximar-mcp` — Model Context Protocol server for notebook evaluation and AI integration
3. **Maxima** (GPL-2.0, system dependency) — The Maxima computer algebra system, installed separately by the user.

The Rust binaries are downloaded on demand rather than bundled in the VSIX, keeping the MIT-licensed extension and GPL-licensed binaries clearly separated.

## Installing the language tools

### Auto-download (recommended)

On first activation, the extension checks whether the three tool binaries are available. If any are missing, it shows a notification offering to download them from GitHub Releases.

You can also trigger this manually with the **Maxima: Download/Update Tools** command from the command palette.

Downloaded binaries are stored in the extension's global storage directory:

```
<globalStorageUri>/
  bin/
    maxima-lsp(.exe)
    maxima-dap(.exe)
    aximar-mcp(.exe)
  tools-version.json
```

The extension checks for updates once every 24 hours and shows a notification when a newer version is available.

### Manual: cargo install

If you have a Rust toolchain installed:

```sh
cargo install --locked --force --git https://github.com/cmsd2/aximar maxima-lsp maxima-dap aximar-mcp
```

The binaries will be placed in `~/.cargo/bin/` which is typically on your PATH.

### Manual: download from GitHub

Download the archive for your platform from the [aximar releases page](https://github.com/cmsd2/aximar/releases), extract the binaries, and either:

- Place them on your PATH, or
- Set the paths in VS Code settings (see Configuration below)

## Path resolution

For each binary, the extension checks in order:

1. **User setting** — e.g. `maxima.lsp.path` for maxima-lsp
2. **Managed install** — `<globalStorageUri>/bin/<binary>`
3. **System PATH** — the binary name without a path

## GitHub Release format

Release archives are produced by the `release-tools.yml` CI workflow in the aximar repository.

**Archive naming:**

| Platform | Archive |
|----------|---------|
| macOS (Apple Silicon) | `aximar-tools-aarch64-apple-darwin.tar.gz` |
| macOS (Intel) | `aximar-tools-x86_64-apple-darwin.tar.gz` |
| Linux (x64) | `aximar-tools-x86_64-unknown-linux-gnu.tar.gz` |
| Linux (arm64) | `aximar-tools-aarch64-unknown-linux-gnu.tar.gz` |
| Windows (x64) | `aximar-tools-x86_64-pc-windows-msvc.zip` |
| Windows (arm64) | `aximar-tools-aarch64-pc-windows-msvc.zip` |

Each archive contains all three binaries (`maxima-lsp`, `maxima-dap`, `aximar-mcp`).

**Tagging convention:**

- `tools-v*` — Standalone CLI tool releases (e.g. `tools-v0.1.0`)
- `v*` — Tauri desktop app releases (separate workflow)

## CI/CD: release-tools.yml

The workflow at `.github/workflows/release-tools.yml` in the aximar repo:

1. Triggers on tags matching `tools-v*`
2. Builds all three crates with `cargo build --release` for 6 platform targets
3. Packages binaries into `.tar.gz` (Unix) or `.zip` (Windows) archives
4. Creates a draft GitHub Release with the archives attached

To cut a new tools release:

```sh
git tag tools-v0.2.0
git push --tags
```

After the CI completes, review and publish the draft release on GitHub.

## Configuration reference

| Setting | Default | Description |
|---------|---------|-------------|
| `maxima.lsp.enabled` | `true` | Enable the language server |
| `maxima.lsp.path` | `""` | Absolute path to maxima-lsp binary |
| `maxima.dap.path` | `""` | Absolute path to maxima-dap binary |
| `maxima.notebook.mcpPath` | `""` | Absolute path to aximar-mcp binary |
| `maxima.maximaPath` | `""` | Absolute path to the maxima binary |
| `maxima.notebook.evalTimeout` | `60` | Cell evaluation timeout in seconds |

## Licensing

- **Extension** (this repository): MIT license
- **Language tools** (aximar repository): GPL-3.0-or-later
- **Maxima**: GPL-2.0

The tools are distributed as separate binaries, not bundled in the extension package. Users download them separately (either automatically via the extension or manually).

## Troubleshooting

### Binary not found

If the extension reports that a binary is not found:

1. Run **Maxima: Download/Update Tools** from the command palette
2. Or set the path explicitly in settings (e.g. `maxima.lsp.path`)
3. Or ensure the binary is on your system PATH

### Permission denied (macOS/Linux)

Downloaded binaries should be marked executable automatically. If not:

```sh
chmod +x ~/.vscode/extensions/globalStorage/*/bin/maxima-*
chmod +x ~/.vscode/extensions/globalStorage/*/bin/aximar-*
```

### Firewall blocking downloads

The extension downloads from `api.github.com` and `github.com`. If your network blocks these, download the archives manually and set the binary paths in settings.

### Update check not working

The extension checks for updates at most once every 24 hours. To force a check, run the **Maxima: Download/Update Tools** command.
