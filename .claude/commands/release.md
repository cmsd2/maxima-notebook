---
name: release
description: Release a new version of the maxima-extension VS Code extension
argument-hint: "<new-version>"
---

# Release maxima-extension

Release a new version of the VS Code extension. This extension is NOT published to the marketplace — it is pushed to the `cmsd2` fork remote only.

## Arguments

`$ARGUMENTS` is the new version number (e.g. `0.2.0`). If not provided, ask the user.

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
- Rename the `## [Unreleased]` heading to `## [<new-version>]`.
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
- Push to the **cmsd2** remote (not origin): `git push cmsd2 main && git push cmsd2 v<new-version>`

### 7. Summary

Print a summary: version, tag, remote pushed to, and remind the user that this extension is not marketplace-published.
