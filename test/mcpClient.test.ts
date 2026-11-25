/**
 * The extension's MCP client against real aximar-mcp builds. Set
 * AXIMAR_MCP to a build with client cells (and Maxima on PATH) and
 * AXIMAR_MCP_OLD to tools-v0.5.0 or earlier; each test skips without its
 * binary.
 */
import { afterEach, describe, expect, it } from "vitest";
import { McpProcessManager } from "../src/notebook/mcpClient";
import { outputChannel } from "./vscode-mock";

const current = process.env.AXIMAR_MCP;
const old = process.env.AXIMAR_MCP_OLD;

let manager: McpProcessManager | undefined;

function start(binary: string): McpProcessManager {
  const channel = outputChannel();
  manager = new McpProcessManager(channel as never, () => binary);
  return manager;
}

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
});

describe.skipIf(!old)("an aximar-mcp without client cells", () => {
  it("is detected from its tool list", async () => {
    const m = start(old!);
    await m.ensureRunning();
    expect(m.supportsClientCells).toBe(false);
  });
});

describe.skipIf(!current)("an aximar-mcp with client cells", () => {
  it("is detected from its tool list", async () => {
    const m = start(current!);
    await m.ensureRunning();
    expect(m.supportsClientCells).toBe(true);
  });

  it("numbers runs and resolves %oN and % against the cells named", async () => {
    const m = start(current!);
    const session = await m.createSession();
    const a = await m.evaluateExpression("10;", session, { id: "a", above: [] });
    const b = await m.evaluateExpression("5;", session, { id: "b", above: ["a"] });
    expect([a.execution_count, b.execution_count]).toEqual([1, 2]);

    // %o1 is cell a's run; % is the nearest cell above with an output (b)
    const c = await m.evaluateExpression("%o1 + %;", session, { id: "c", above: ["a", "b"] });
    expect(c.is_error).toBe(false);
    expect(c.execution_count).toBe(3);
    expect(c.latex).toContain("15");

    // Rerun a with a new value: % in c now reads b, %o1 is gone
    const a2 = await m.evaluateExpression("100;", session, { id: "a", above: [] });
    expect(a2.execution_count).toBe(4);
    const c2 = await m.evaluateExpression("%o4 + %;", session, { id: "c", above: ["a", "b"] });
    expect(c2.latex).toContain("105");
  });

  it("shows a label with no value as the cell's own error, with its number", async () => {
    const m = start(current!);
    const session = await m.createSession();
    const r = await m.evaluateExpression("%o7 + 1;", session, { id: "x", above: [] });
    expect(r.is_error).toBe(true);
    expect(r.error).toContain("%o7");
    expect(r.execution_count).toBe(1);
  });

  it("numbers from 1 again after a restart", async () => {
    const m = start(current!);
    const session = await m.createSession();
    await m.evaluateExpression("1;", session, { id: "a", above: [] });
    await m.restartSession(session);
    const r = await m.evaluateExpression("2;", session, { id: "a", above: [] });
    expect(r.execution_count).toBe(1);
  });
});
