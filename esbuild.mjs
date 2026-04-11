import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// Extension host (Node.js, CommonJS)
const extCtx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  outfile: "out/extension.js",
  external: ["vscode"],
  logLevel: "info",
});

// Notebook renderer (browser, ES modules)
const rendererCtx = await esbuild.context({
  entryPoints: ["src/renderers/maxima/index.ts"],
  bundle: true,
  format: "esm",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "browser",
  outfile: "out/renderers/maxima/index.js",
  external: [],
  logLevel: "info",
  loader: {
    ".css": "css",
    ".woff2": "file",
    ".woff": "file",
    ".ttf": "file",
  },
});

if (watch) {
  await Promise.all([extCtx.watch(), rendererCtx.watch()]);
} else {
  await Promise.all([extCtx.rebuild(), rendererCtx.rebuild()]);
  await Promise.all([extCtx.dispose(), rendererCtx.dispose()]);
}
