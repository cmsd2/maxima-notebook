import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * Plugin that inlines CSS imports as <style> tags injected at runtime.
 * Necessary for VS Code notebook renderers where only JS is loaded.
 * Font url() references are first resolved to data: URIs by esbuild's
 * loader config, then the complete CSS is embedded in the JS bundle.
 */
const cssInlinePlugin = {
  name: "css-inline",
  setup(build) {
    // Intercept CSS imports and return JS that injects a <style> element
    build.onLoad({ filter: /\.css$/ }, async (args) => {
      // Bundle the CSS file separately so url() references get processed
      const result = await esbuild.build({
        entryPoints: [args.path],
        bundle: true,
        write: false,
        minify: production,
        loader: {
          ".woff2": "dataurl",
          ".woff": "dataurl",
          ".ttf": "dataurl",
        },
      });
      const css = result.outputFiles[0].text;
      return {
        contents: `(function(){
  if (typeof document !== "undefined") {
    var s = document.createElement("style");
    s.textContent = ${JSON.stringify(css)};
    document.head.appendChild(s);
  }
})();`,
        loader: "js",
      };
    });
  },
};

/**
 * Copy aximar-notebook-format's WebAssembly next to the bundle: the package
 * loads it from `${__dirname}`, which is out/ once bundled, and node_modules
 * isn't packaged.
 */
const notebookFormatWasmPlugin = {
  name: "notebook-format-wasm",
  setup(build) {
    build.onEnd(() => {
      const wasm = "aximar_notebook_format_bg.wasm";
      fs.mkdirSync("out", { recursive: true });
      fs.copyFileSync(path.join("node_modules", "aximar-notebook-format", wasm), path.join("out", wasm));
    });
  },
};

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
  plugins: [notebookFormatWasmPlugin],
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
  plugins: [cssInlinePlugin],
});

if (watch) {
  await Promise.all([extCtx.watch(), rendererCtx.watch()]);
} else {
  await Promise.all([extCtx.rebuild(), rendererCtx.rebuild()]);
  await Promise.all([extCtx.dispose(), rendererCtx.dispose()]);
}
