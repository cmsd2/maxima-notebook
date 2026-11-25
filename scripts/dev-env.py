#!/usr/bin/env python3
"""Launch VS Code with this extension and a chosen build of the aximar tools.

Each run builds the extension, gets maxima-lsp, maxima-dap and aximar-mcp
(downloaded, found or built), writes a throwaway VS Code profile whose
settings point at them, and opens an Extension Development Host window.
Your own VS Code profile, settings and extensions are left alone.

Tools (--tools):
  latest                 the newest tools-v* release on GitHub
  tools-v0.5.0, 0.5.0    that release
  system                 whatever the extension finds itself (PATH, downloads)
  DIR                    a folder holding the three binaries
  DIR                    an aximar checkout: built there with cargo
  git:REF[+REF...]       refs in the aximar repository (--aximar-repo), the
                         first checked out and the rest merged into it, then
                         built; REF is a branch, tag or commit, or pr:N for a
                         pull request. Builds are cached by commit.

Examples:
  scripts/dev-env.py --tools latest
  scripts/dev-env.py --tools git:origin/master+pr:45 --open ~/maxima/project
  scripts/dev-env.py --tools ~/src/aximar --name mine
  scripts/dev-env.py --list
  scripts/dev-env.py --clean NAME

Profiles, downloads and builds live in the cache folder (--cache), which is
kept short: VS Code puts a socket in the profile folder, and macOS limits
socket paths to 104 bytes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

GITHUB_REPO = "cmsd2/aximar"
TAG_PREFIX = "tools-v"
TOOLS = ("maxima-lsp", "maxima-dap", "aximar-mcp")
SETTINGS = {
    "maxima-lsp": "maxima.lsp.path",
    "maxima-dap": "maxima.dap.path",
    "aximar-mcp": "maxima.notebook.mcpPath",
}
EXTENSION_DIR = Path(__file__).resolve().parent.parent
EXE = ".exe" if os.name == "nt" else ""
SOCKET_PATH_LIMIT = 103


def default_cache() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "maxima-nb-dev"
    base = os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache"
    return Path(base) / "maxima-nb-dev"


def default_aximar_repo() -> Path | None:
    env = os.environ.get("AXIMAR_REPO")
    if env:
        return Path(env).expanduser()
    for name in ("aximar-openspec", "aximar"):
        candidate = EXTENSION_DIR.parent / name
        if (candidate / "crates" / "aximar-mcp").is_dir():
            return candidate
    return None


def run(cmd: list[str], cwd: Path | None = None, env: dict | None = None, quiet=False) -> str:
    """Run a command, failing the script with its output if it fails."""
    if not quiet:
        print("+", " ".join(str(c) for c in cmd), flush=True)
    result = subprocess.run(
        [str(c) for c in cmd], cwd=cwd, env=env, text=True,
        stdout=subprocess.PIPE if quiet else None,
        stderr=subprocess.PIPE if quiet else None,
    )
    if result.returncode != 0:
        if quiet:
            sys.stderr.write(result.stdout or "")
            sys.stderr.write(result.stderr or "")
        sys.exit(f"error: {' '.join(str(c) for c in cmd)} failed ({result.returncode})")
    return (result.stdout or "").strip()


def git(repo: Path, *args: str) -> str:
    return run(["git", "-C", str(repo), *args], quiet=True)


def slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-")[:40] or "default"


# ── Tools ────────────────────────────────────────────────────────────────


def rust_target() -> str:
    machine = platform.machine().lower()
    arch = {"arm64": "aarch64", "aarch64": "aarch64", "x86_64": "x86_64", "amd64": "x86_64"}.get(machine)
    system = {"darwin": "apple-darwin", "linux": "unknown-linux-gnu", "win32": "pc-windows-msvc"}.get(sys.platform)
    if not arch or not system:
        sys.exit(f"error: no release archives for {sys.platform}/{machine}")
    return f"{arch}-{system}"


def github_json(path: str):
    request = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}{path}",
        headers={"User-Agent": "maxima-notebook-dev-env", "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def release_tools(spec: str, cache: Path) -> tuple[Path, str]:
    if spec == "latest":
        releases = github_json("/releases?per_page=50")
        release = next((r for r in releases if r["tag_name"].startswith(TAG_PREFIX)), None)
        if not release:
            sys.exit("error: no tools release found")
    else:
        tag = spec if spec.startswith(TAG_PREFIX) else TAG_PREFIX + spec
        release = github_json(f"/releases/tags/{tag}")
    tag = release["tag_name"]
    out = cache / "tools" / tag
    if all((out / (t + EXE)).exists() for t in TOOLS):
        return out, f"release {tag} (cached)"

    target = rust_target()
    name = f"aximar-tools-{target}" + (".zip" if os.name == "nt" else ".tar.gz")
    asset = next((a for a in release["assets"] if a["name"] == name), None)
    if not asset:
        sys.exit(f"error: release {tag} has no {name}")
    print(f"Downloading {name} from {tag}", flush=True)
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        archive = Path(tmp) / name
        request = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "maxima-notebook-dev-env"})
        with urllib.request.urlopen(request, timeout=300) as response, open(archive, "wb") as f:
            shutil.copyfileobj(response, f)
        extracted = Path(tmp) / "x"
        if name.endswith(".zip"):
            with zipfile.ZipFile(archive) as z:
                z.extractall(extracted)
        else:
            with tarfile.open(archive) as t:
                t.extractall(extracted, filter="data")
        for tool in TOOLS:
            found = next(extracted.rglob(tool + EXE), None)
            if found:
                shutil.copy2(found, out / found.name)
                (out / found.name).chmod(0o755)
    return out, f"release {tag}"


def build(source: Path, target_dir: Path) -> Path:
    env = dict(os.environ, CARGO_TARGET_DIR=str(target_dir))
    cmd = ["cargo", "build", "--release", "--locked"]
    for tool in TOOLS:
        cmd += ["-p", tool]
    run(cmd, cwd=source, env=env)
    return target_dir / "release"


def git_tools(spec: str, repo: Path | None, cache: Path) -> tuple[Path, str]:
    if repo is None or not (repo / ".git").exists():
        sys.exit("error: git: needs the aximar repository; pass --aximar-repo or set AXIMAR_REPO")
    refs = spec[len("git:"):].split("+")
    git(repo, "fetch", "--quiet", "origin")
    commits = []
    for ref in refs:
        if ref.startswith("pr:"):
            number = ref[3:]
            git(repo, "fetch", "--quiet", "origin", f"pull/{number}/head")
            sha = git(repo, "rev-parse", "FETCH_HEAD")
        else:
            sha = git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}")
        subject = git(repo, "log", "-1", "--format=%s", sha)
        print(f"  {ref:<28} {sha[:10]} {subject}")
        commits.append(sha)

    key = hashlib.sha256(" ".join(commits).encode()).hexdigest()[:12]
    out = cache / "tools" / f"git-{key}"
    label = f"git {'+'.join(refs)} ({key})"
    if all((out / (t + EXE)).exists() for t in TOOLS):
        return out, label + ", cached"

    worktree = cache / "src"
    git(repo, "worktree", "prune")
    if (worktree / ".git").exists():
        git(worktree, "checkout", "--quiet", "--detach", "--force", commits[0])
        git(worktree, "clean", "--quiet", "-fdx")
    else:
        git(repo, "worktree", "add", "--quiet", "--detach", str(worktree), commits[0])
    for sha, ref in zip(commits[1:], refs[1:]):
        result = subprocess.run(
            ["git", "-C", str(worktree), "merge", "--quiet", "--no-edit", sha],
            text=True, capture_output=True,
        )
        if result.returncode != 0:
            subprocess.run(["git", "-C", str(worktree), "merge", "--abort"], capture_output=True)
            sys.exit(f"error: {ref} doesn't merge cleanly:\n{result.stdout}{result.stderr}")

    release = build(worktree, cache / "target")
    out.mkdir(parents=True, exist_ok=True)
    for tool in TOOLS:
        shutil.copy2(release / (tool + EXE), out / (tool + EXE))
    (out / "source.json").write_text(json.dumps({"refs": refs, "commits": commits}, indent=2) + "\n")
    return out, label


def resolve_tools(spec: str, args) -> tuple[Path | None, str]:
    if spec == "system":
        return None, "the extension's own lookup (setting, downloads, PATH)"
    if spec.startswith("git:"):
        return git_tools(spec, args.aximar_repo, args.cache)
    path = Path(spec).expanduser()
    if path.is_dir():
        path = path.resolve()
        if (path / "crates" / "aximar-mcp").is_dir():
            target = Path(os.environ.get("CARGO_TARGET_DIR") or path / "target")
            return build(path, target), f"built from {path}"
        missing = [t for t in TOOLS if not (path / (t + EXE)).exists()]
        if missing:
            sys.exit(f"error: {path} has no {', '.join(missing)}")
        return path, f"binaries in {path}"
    if spec == "latest" or re.fullmatch(rf"({TAG_PREFIX})?\d+\.\d+\.\d+.*", spec):
        return release_tools(spec, args.cache)
    sys.exit(f"error: don't know what --tools {spec} means; see --help")


def describe(tools: Path | None) -> None:
    if tools is None:
        return
    for tool in TOOLS:
        binary = tools / (tool + EXE)
        # Before tools 0.6.0, maxima-dap and maxima-lsp start a server on
        # --version; with stdin closed they exit at once and print nothing
        try:
            result = subprocess.run([str(binary), "--version"], stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=10)
            out = result.stdout.strip() if result.returncode == 0 else ""
        except subprocess.TimeoutExpired:
            out = ""
        version = out or "(no --version)"
        print(f"  {tool:<11} {version:<20} {binary}")


# ── Profile and launch ────────────────────────────────────────────────────


def write_profile(profile: Path, tools: Path | None) -> None:
    settings_file = profile / "user" / "User" / "settings.json"
    settings_file.parent.mkdir(parents=True, exist_ok=True)
    (profile / "ext").mkdir(exist_ok=True)
    settings = {}
    if settings_file.exists():
        try:
            settings = json.loads(settings_file.read_text())
        except json.JSONDecodeError:
            pass
    settings.update({
        "security.workspace.trust.enabled": False,
        "workbench.startupEditor": "none",
        "extensions.ignoreRecommendations": True,
        "update.mode": "none",
        "telemetry.telemetryLevel": "off",
        # A .macnb named on the command line opens before the development
        # extension registers its notebook type; this keeps it a notebook
        "workbench.editorAssociations": {"*.macnb": "maxima-notebook"},
    })
    for tool, key in SETTINGS.items():
        if tools is None:
            settings.pop(key, None)
        else:
            settings[key] = str(tools / (tool + EXE))
    settings_file.write_text(json.dumps(settings, indent=2) + "\n")


def build_extension() -> None:
    if not (EXTENSION_DIR / "node_modules").is_dir():
        run(["npm", "ci"], cwd=EXTENSION_DIR)
    run(["node", "esbuild.mjs"], cwd=EXTENSION_DIR)


def launch(profile: Path, open_paths: list[Path], code_app: str) -> None:
    args = [
        "--user-data-dir", str(profile / "user"),
        "--extensions-dir", str(profile / "ext"),
        f"--extensionDevelopmentPath={EXTENSION_DIR}",
        *[str(p) for p in open_paths],
    ]
    if sys.platform == "darwin":
        # open -n starts a separate instance that outlives this script
        cmd = ["open", "-n", "-a", code_app, "--args", *args]
        run(cmd, quiet=True)
    else:
        cli = shutil.which("code") or sys.exit("error: no code command on PATH")
        subprocess.Popen([cli, "--new-window", *args], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def list_cache(cache: Path) -> None:
    print(f"Cache: {cache}")
    for kind in ("profiles", "tools"):
        folder = cache / kind
        names = sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []
        print(f"{kind}: {', '.join(names) or '(none)'}")
        if kind == "tools":
            for name in names:
                source = folder / name / "source.json"
                if source.exists():
                    print(f"  {name}: {'+'.join(json.loads(source.read_text())['refs'])}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__.split("\n\n")[0],
        epilog="\n\n".join(__doc__.split("\n\n")[1:]),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--tools", default="latest", help="which aximar tools to use (default: latest)")
    parser.add_argument("--name", help="profile name (default: from --tools); reusing one keeps its state")
    parser.add_argument("--open", action="append", default=[], type=Path, metavar="PATH",
                        help="folder or file to open; repeatable")
    parser.add_argument("--aximar-repo", type=Path, default=default_aximar_repo(),
                        help="aximar clone for git: specs (default: $AXIMAR_REPO or a sibling checkout)")
    parser.add_argument("--cache", type=Path, default=default_cache(), help="cache folder (default: %(default)s)")
    parser.add_argument("--code-app", default="Visual Studio Code", help="macOS app name, e.g. 'Visual Studio Code - Insiders'")
    parser.add_argument("--no-build", action="store_true", help="don't rebuild the extension")
    parser.add_argument("--no-launch", action="store_true", help="prepare the profile and print the command only")
    parser.add_argument("--fresh", action="store_true", help="delete the profile's state before launching")
    parser.add_argument("--list", action="store_true", help="list cached profiles and tool builds")
    parser.add_argument("--clean", metavar="NAME", help="delete a profile (or 'all' for the whole cache)")
    args = parser.parse_args()
    args.cache = args.cache.expanduser()

    if args.list:
        list_cache(args.cache)
        return
    if args.clean:
        target = args.cache if args.clean == "all" else args.cache / "profiles" / args.clean
        if args.clean == "all" and args.aximar_repo:
            subprocess.run(["git", "-C", str(args.aximar_repo), "worktree", "remove", "--force",
                            str(args.cache / "src")], capture_output=True)
        shutil.rmtree(target, ignore_errors=True)
        print(f"Removed {target}")
        return

    tools, label = resolve_tools(args.tools, args)
    print(f"Tools: {label}")
    describe(tools)

    profile = args.cache / "profiles" / (args.name or slug(args.tools))
    if args.fresh:
        shutil.rmtree(profile, ignore_errors=True)
    socket_dir = profile / "user"
    if len(str(socket_dir)) + 25 > SOCKET_PATH_LIMIT:
        sys.exit(f"error: {socket_dir} is too long for VS Code's socket; use a shorter --cache or --name")
    write_profile(profile, tools)
    print(f"Profile: {profile}")

    if not args.no_build:
        build_extension()

    open_paths = [p.expanduser().resolve() for p in args.open]
    if args.no_launch:
        print("Launch with:")
        print(f"  open -n -a '{args.code_app}' --args --user-data-dir {profile}/user "
              f"--extensions-dir {profile}/ext --extensionDevelopmentPath={EXTENSION_DIR} "
              + " ".join(str(p) for p in open_paths))
        return
    launch(profile, open_paths, args.code_app)
    print("Opened an Extension Development Host window.")


if __name__ == "__main__":
    main()
