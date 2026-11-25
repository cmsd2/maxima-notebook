import { defineConfig } from "vitest/config";
import * as path from "path";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests start aximar-mcp and Maxima
    testTimeout: 60_000,
  },
  resolve: {
    alias: { vscode: path.resolve(__dirname, "test/vscode-mock.ts") },
  },
});
