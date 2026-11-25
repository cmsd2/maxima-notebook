/**
 * The round trip of S1 (cmsd2/aximar#16): every notebook in the demos
 * repository (cmsd2/maxima-demos), saved by Aximar, opened and saved in
 * VS Code, then opened and saved in Aximar again, comes back byte for
 * byte. Aximar's side is the aximar-notebook-format package, the code the
 * window, aximar-mcp and batch runs use; VS Code's side is notebookFile.ts.
 *
 * The demos hold print text, LaTeX results, Plotly figures and PNG images,
 * but no cell IDs, metadata, errors or raw cells: notebookFile.test.ts
 * checks those against the shared test notebooks.
 *
 * Reads the demos from $DEMOS, or a demos checkout next to this one
 * (../demos/notebooks); skips when there's none.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { read, write } from "aximar-notebook-format";
import { notebookFromFile, notebookToFile } from "../src/notebook/notebookFile";

const DEMOS = process.env.DEMOS ?? path.resolve(__dirname, "../../demos/notebooks");

function notebooks(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(macnb|ipynb)$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

const files = notebooks(DEMOS);

describe.skipIf(files.length === 0)(`round trip of the demo notebooks in ${DEMOS}`, () => {
  it.each(files.map((f) => [path.relative(DEMOS, f), f]))("%s", (_name, file) => {
    const savedByAximar = write(read(fs.readFileSync(file, "utf8")));
    const savedByVsCode = notebookToFile(notebookFromFile(savedByAximar));
    expect(savedByVsCode).toBe(savedByAximar);
    const savedByAximarAgain = write(read(savedByVsCode));
    expect(savedByAximarAgain).toBe(savedByAximar);
  });
});
