---
name: release
description: Release a new version of the maxima-notebook VS Code extension
argument-hint: "<new-version>"
---

# Release maxima-notebook

Release a new version of the VS Code extension to the VS Code marketplace.

## Arguments

`$ARGUMENTS` is the new version number (e.g. `0.6.0`). If not provided, ask the user.

An odd minor version (0.5.x) is a pre-release and an even one (0.6.x) a stable release, as CONTRIBUTING.md describes.

## Pre-flight checks

1. Verify on `main` branch.
2. Verify the working tree is clean (no uncommitted changes).
3. Read `package.json` to get the current version.
4. Confirm the new version is different from the current version.
5. Check that the git tag `v<new-version>` does not already exist.

If any check fails, report it and stop.

## Steps

### 1. Update version

- Update `"version"` in `package.json` to the new version.

### 2. Update lockfile

- Run `npm install` to update `package-lock.json` with the new version.

### 3. Update CHANGELOG.md

- Read `CHANGELOG.md`.
- Rename the `## [Unreleased]` heading to `## [<new-version>]`, or `## [<new-version>] (pre-release)` for an odd minor.
- Add a fresh empty `## [Unreleased]` section above it with subsections `### Added`, `### Changed`, `### Fixed`.
- Show the user the changelog diff and ask for confirmation before continuing.

### 4. Commit

- Stage: `package.json`, `package-lock.json`, `CHANGELOG.md`
- Commit message: `Release v<new-version>`
- Do NOT use `--no-verify`.

### 5. Tag

- Create an annotated tag: `git tag v<new-version>`

### 6. Push

- Ask the user for confirmation before pushing.
- Push: `git push origin main && git push origin v<new-version>`

### 7. Publish to marketplace

- Check the package first: `npx @vscode/vsce ls` lists what goes in; it should hold `out/` (with `aximar_notebook_format_bg.wasm`), the docs and media, and no tests, `scripts/` or `.claude/`.
- Run `npx @vscode/vsce publish --pre-release` for an odd minor, or `npx @vscode/vsce publish` for an even one.
- If the user hasn't logged in yet, instruct them to run `npx @vscode/vsce login cmsd2` first.

### 8. Summary

Print a summary: version, tag, and marketplace link (`https://marketplace.visualstudio.com/items?itemName=cmsd2.maxima-notebook`).
