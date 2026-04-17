/**
 * Manages discovery, download, and version management of aximar tool
 * binaries (maxima-lsp, maxima-dap, aximar-mcp) from GitHub Releases.
 *
 * Path resolution order: user setting → globalStorageUri/bin/ → PATH
 */

import * as vscode from "vscode";
import { execFileSync } from "child_process";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

const GITHUB_OWNER = "cmsd2";
const GITHUB_REPO = "aximar";
const TAG_PREFIX = "tools-v";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Binary names and their corresponding user settings */
const TOOLS = [
  { name: "maxima-lsp", settingKey: "maxima.lsp.path" },
  { name: "maxima-dap", settingKey: "maxima.dap.path" },
  { name: "aximar-mcp", settingKey: "maxima.notebook.mcpPath" },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];

interface VersionInfo {
  version: string;
  lastChecked: string;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  assets: GitHubAsset[];
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

/**
 * Map (platform, arch) to Rust target triple.
 */
function getRustTarget(): string | undefined {
  const platform = process.platform;
  const arch = process.arch;

  const map: Record<string, Record<string, string>> = {
    darwin: {
      arm64: "aarch64-apple-darwin",
      x64: "x86_64-apple-darwin",
    },
    linux: {
      x64: "x86_64-unknown-linux-gnu",
      arm64: "aarch64-unknown-linux-gnu",
    },
    win32: {
      x64: "x86_64-pc-windows-msvc",
      arm64: "aarch64-pc-windows-msvc",
    },
  };

  return map[platform]?.[arch];
}

function getArchiveName(target: string): string {
  if (target.includes("windows")) {
    return `aximar-tools-${target}.zip`;
  }
  return `aximar-tools-${target}.tar.gz`;
}

function exeSuffix(): string {
  return process.platform === "win32" ? ".exe" : "";
}

export class BinaryManager {
  private binDir: string;
  private storageDir: string;
  private versionFilePath: string;

  constructor(globalStorageUri: vscode.Uri) {
    this.storageDir = globalStorageUri.fsPath;
    this.binDir = path.join(this.storageDir, "bin");
    this.versionFilePath = path.join(this.storageDir, "tools-version.json");
    this.cleanupOldBinaries();
  }

  /** Remove leftover .old binaries from a previous Windows update. */
  private cleanupOldBinaries(): void {
    for (const tool of TOOLS) {
      const oldPath = path.join(this.binDir, tool.name + exeSuffix() + ".old");
      fs.unlink(oldPath, () => {
        // best-effort, ignore errors
      });
    }
  }

  /**
   * Resolve the absolute path of a tool binary.
   * Priority: user setting → globalStorageUri/bin/ → PATH
   * Returns undefined if not found anywhere.
   */
  resolve(name: ToolName, settingKey: string): string | undefined {
    // 1. User setting
    const parts = settingKey.split(".");
    const section = parts.slice(0, -1).join(".");
    const key = parts[parts.length - 1];
    const config = vscode.workspace.getConfiguration(section);
    const userPath = config.get<string>(key, "").trim();
    if (userPath) {
      return userPath;
    }

    // 2. globalStorageUri/bin/
    const managedPath = path.join(this.binDir, name + exeSuffix());
    if (fs.existsSync(managedPath)) {
      return managedPath;
    }

    // 3. PATH
    if (this.isOnPath(name)) {
      return name; // just the command name — let the OS find it
    }

    return undefined;
  }

  /**
   * Resolve the path for a specific tool by name.
   */
  resolveTool(name: ToolName): string | undefined {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) {
      return undefined;
    }
    return this.resolve(tool.name, tool.settingKey);
  }

  /**
   * Check if Maxima is installed. If not, show a notification with a
   * download link. Maxima is a system dependency — we can't auto-download it.
   */
  async checkMaximaInstalled(): Promise<void> {
    const config = vscode.workspace.getConfiguration("maxima");
    const maximaPath = config.get<string>("maximaPath", "").trim();

    if (maximaPath) {
      // User configured an explicit path — trust it
      return;
    }

    if (this.isOnPath("maxima")) {
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      "Maxima is not installed or not on PATH. " +
        "Debugging, Run File, and notebooks require Maxima.",
      "Download Maxima",
      "Set Path",
      "Dismiss",
    );

    if (choice === "Download Maxima") {
      vscode.env.openExternal(
        vscode.Uri.parse("https://maxima.sourceforge.io/download.html"),
      );
    } else if (choice === "Set Path") {
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "maxima.maximaPath",
      );
    }
  }

  /**
   * Check all 3 binaries. If any are missing, prompt the user to download.
   */
  async promptInstallIfNeeded(): Promise<void> {
    const missing: ToolName[] = [];
    for (const tool of TOOLS) {
      if (!this.resolve(tool.name, tool.settingKey)) {
        missing.push(tool.name);
      }
    }

    if (missing.length === 0) {
      return;
    }

    const target = getRustTarget();
    if (!target) {
      // Unsupported platform — can't auto-download
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `Maxima extension tools not found: ${missing.join(", ")}. ` +
        "Download them from GitHub?",
      "Download",
      "Install with cargo",
      "Dismiss",
    );

    if (choice === "Download") {
      await vscode.commands.executeCommand("maxima.downloadTools");
    } else if (choice === "Install with cargo") {
      const terminal = vscode.window.createTerminal("Install Maxima Tools");
      terminal.show();
      terminal.sendText(
        "cargo install --git https://github.com/cmsd2/aximar maxima-lsp maxima-dap aximar-mcp",
      );
    }
  }

  /**
   * Query GitHub Releases API (max once per 24h) and prompt if a newer
   * version is available.
   */
  async checkForUpdates(): Promise<boolean> {
    const versionInfo = this.readVersionInfo();
    if (!versionInfo) {
      return false; // No managed install — nothing to update
    }

    const lastChecked = new Date(versionInfo.lastChecked).getTime();
    if (Date.now() - lastChecked < CHECK_INTERVAL_MS) {
      return false; // Checked recently
    }

    let latest: GitHubRelease;
    try {
      latest = await this.fetchLatestRelease();
    } catch {
      return false; // Network error — silently skip
    }

    const latestVersion = latest.tag_name.replace(TAG_PREFIX, "");
    // Update lastChecked even if version is current
    this.writeVersionInfo(versionInfo.version, new Date().toISOString());

    if (latestVersion === versionInfo.version) {
      return false;
    }

    const choice = await vscode.window.showInformationMessage(
      `Maxima tools update available: ${versionInfo.version} → ${latestVersion}`,
      "Update",
      "What's New",
      "Dismiss",
    );

    if (choice === "Update") {
      return await this.downloadTools(latest.tag_name);
    } else if (choice === "What's New") {
      vscode.env.openExternal(vscode.Uri.parse(latest.html_url));
    }
    return false;
  }

  /**
   * Download the tool archive for the current platform, extract to
   * globalStorageUri/bin/, set executable permissions, and write
   * version.json.
   */
  async downloadTools(tag?: string): Promise<boolean> {
    const target = getRustTarget();
    if (!target) {
      vscode.window.showErrorMessage(
        `Unsupported platform: ${process.platform}-${process.arch}. ` +
          "Please build from source with cargo install.",
      );
      return false;
    }

    return (await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Downloading Maxima tools",
        cancellable: false,
      },
      async (progress) => {
        try {
          // Fetch release info
          progress.report({ message: "Fetching release info..." });
          let release: GitHubRelease;
          if (tag) {
            release = await this.fetchRelease(tag);
          } else {
            release = await this.fetchLatestRelease();
          }

          const archiveName = getArchiveName(target);
          const asset = release.assets.find((a) => a.name === archiveName);
          if (!asset) {
            vscode.window.showErrorMessage(
              `No binary archive found for ${target} in release ${release.tag_name}. ` +
                `Expected: ${archiveName}`,
            );
            return;
          }

          // Download
          progress.report({ message: `Downloading ${archiveName}...` });
          const data = await this.downloadUrl(asset.browser_download_url);

          // Ensure bin directory exists
          await fs.promises.mkdir(this.binDir, { recursive: true });

          // Move existing binaries out of the way before extracting.
          // On Unix: unlink works (running process keeps the old inode).
          // On Windows: can't delete a running .exe, but rename works —
          //   move to .old and clean up later.
          for (const tool of TOOLS) {
            const binPath = path.join(this.binDir, tool.name + exeSuffix());
            try {
              if (process.platform === "win32") {
                const oldPath = binPath + ".old";
                try {
                  await fs.promises.unlink(oldPath);
                } catch {
                  // .old may not exist
                }
                await fs.promises.rename(binPath, oldPath);
              } else {
                await fs.promises.unlink(binPath);
              }
            } catch {
              // File may not exist yet
            }
          }

          // Extract
          progress.report({ message: "Extracting..." });
          if (archiveName.endsWith(".zip")) {
            await this.extractZip(data, this.binDir);
          } else {
            await this.extractTarGz(data, this.binDir);
          }

          // Set executable permissions on non-Windows
          if (process.platform !== "win32") {
            for (const tool of TOOLS) {
              const binPath = path.join(this.binDir, tool.name);
              try {
                await fs.promises.chmod(binPath, 0o755);
              } catch {
                // File might not exist if not included in this release
              }
            }
          }

          // Write version info
          const version = release.tag_name.replace(TAG_PREFIX, "");
          this.writeVersionInfo(version, new Date().toISOString());

          vscode.window.showInformationMessage(
            `Maxima tools ${version} installed successfully.`,
          );
          return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Failed to download Maxima tools: ${message}`,
          );
          return false;
        }
      },
    )) ?? false;
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private isOnPath(command: string): boolean {
    try {
      const which = process.platform === "win32" ? "where" : "which";
      execFileSync(which, [command], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  private readVersionInfo(): VersionInfo | undefined {
    try {
      const raw = fs.readFileSync(this.versionFilePath, "utf-8");
      return JSON.parse(raw) as VersionInfo;
    } catch {
      return undefined;
    }
  }

  private writeVersionInfo(version: string, lastChecked: string): void {
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(
        this.versionFilePath,
        JSON.stringify({ version, lastChecked } satisfies VersionInfo, null, 2),
      );
    } catch {
      // Non-critical — swallow
    }
  }

  private fetchLatestRelease(): Promise<GitHubRelease> {
    // List releases and find the latest tools-v* tag
    return new Promise((resolve, reject) => {
      const options = {
        hostname: "api.github.com",
        path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases`,
        headers: { "User-Agent": "maxima-extension" },
      };

      https
        .get(options, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            const location = res.headers.location;
            if (location) {
              this.httpsGetJson<GitHubRelease[]>(location).then(
                (releases) => {
                  const toolRelease = releases.find((r) =>
                    r.tag_name.startsWith(TAG_PREFIX),
                  );
                  if (toolRelease) {
                    resolve(toolRelease);
                  } else {
                    reject(new Error("No tools release found"));
                  }
                },
                reject,
              );
              return;
            }
          }

          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const releases = JSON.parse(body) as GitHubRelease[];
              const toolRelease = releases.find((r) =>
                r.tag_name.startsWith(TAG_PREFIX),
              );
              if (toolRelease) {
                resolve(toolRelease);
              } else {
                reject(new Error("No tools release found"));
              }
            } catch (err) {
              reject(err);
            }
          });
        })
        .on("error", reject);
    });
  }

  private fetchRelease(tag: string): Promise<GitHubRelease> {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${tag}`;
    return this.httpsGetJson<GitHubRelease>(url);
  }

  private httpsGetJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: { "User-Agent": "maxima-extension" },
      };

      https
        .get(options, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            const location = res.headers.location;
            if (location) {
              this.httpsGetJson<T>(location).then(resolve, reject);
              return;
            }
          }

          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body) as T);
            } catch (err) {
              reject(err);
            }
          });
        })
        .on("error", reject);
    });
  }

  /**
   * Download a URL, following redirects.
   * Returns the response body as a Buffer.
   */
  private downloadUrl(url: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doGet = (targetUrl: string, redirectCount: number) => {
        if (redirectCount > 5) {
          reject(new Error("Too many redirects"));
          return;
        }
        const parsedUrl = new URL(targetUrl);
        const options = {
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          headers: { "User-Agent": "maxima-extension" },
        };

        https
          .get(options, (res) => {
            if (
              (res.statusCode === 301 ||
                res.statusCode === 302 ||
                res.statusCode === 307) &&
              res.headers.location
            ) {
              doGet(res.headers.location, redirectCount + 1);
              return;
            }
            if (res.statusCode !== 200) {
              reject(
                new Error(`HTTP ${res.statusCode} downloading ${targetUrl}`),
              );
              return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks)));
          })
          .on("error", reject);
      };
      doGet(url, 0);
    });
  }

  /**
   * Extract a .tar.gz archive to the target directory.
   * Only extracts files (not directories) and strips leading path components
   * so binaries land directly in the target directory.
   */
  private async extractTarGz(data: Buffer, targetDir: string): Promise<void> {
    const decompressed = await new Promise<Buffer>((resolve, reject) => {
      zlib.gunzip(data, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    // Minimal tar parser — tar is 512-byte block format
    let offset = 0;
    while (offset < decompressed.length - 512) {
      const header = decompressed.subarray(offset, offset + 512);

      // Check for end-of-archive (two zero blocks)
      if (header.every((b) => b === 0)) {
        break;
      }

      // Extract filename (bytes 0-99, null-terminated)
      const nameEnd = header.indexOf(0, 0);
      const rawName = header
        .subarray(0, Math.min(nameEnd >= 0 ? nameEnd : 100, 100))
        .toString("utf-8");

      // Extract file size (bytes 124-135, octal)
      const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
      const size = parseInt(sizeStr, 8) || 0;

      // Extract type flag (byte 156): '0' or '\0' = regular file
      const typeFlag = header[156];
      const isFile = typeFlag === 0 || typeFlag === 0x30; // '\0' or '0'

      // Advance past header
      offset += 512;

      if (isFile && size > 0 && rawName) {
        // Strip leading directory components — we just want the filename
        const fileName = path.basename(rawName);
        const filePath = path.join(targetDir, fileName);

        const fileData = decompressed.subarray(offset, offset + size);
        await fs.promises.writeFile(filePath, fileData);
      }

      // Advance past data blocks (rounded up to 512)
      offset += Math.ceil(size / 512) * 512;
    }
  }

  /**
   * Extract a .zip archive on Windows using PowerShell's Expand-Archive.
   */
  private async extractZip(data: Buffer, targetDir: string): Promise<void> {
    // Write zip to a temp file, extract with PowerShell, clean up
    const tmpZip = path.join(this.storageDir, "aximar-tools-download.zip");
    try {
      await fs.promises.writeFile(tmpZip, data);
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${tmpZip}' -DestinationPath '${targetDir}' -Force`,
      ]);
    } finally {
      try {
        await fs.promises.unlink(tmpZip);
      } catch {
        // cleanup best-effort
      }
    }

    // Expand-Archive may create a subdirectory — move files up if needed
    try {
      const entries = await fs.promises.readdir(targetDir);
      if (entries.length === 1) {
        const subdir = path.join(targetDir, entries[0]);
        const stat = await fs.promises.stat(subdir);
        if (stat.isDirectory()) {
          const files = await fs.promises.readdir(subdir);
          for (const file of files) {
            await fs.promises.rename(
              path.join(subdir, file),
              path.join(targetDir, file),
            );
          }
          await fs.promises.rmdir(subdir);
        }
      }
    } catch {
      // best-effort
    }
  }
}
