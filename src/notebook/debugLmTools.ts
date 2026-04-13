/**
 * AI debug tools (LM tools) for inspecting active Maxima debug sessions.
 *
 * Registered via vscode.lm.registerTool() so AI agents (Copilot, Claude, etc.)
 * can read variables, evaluate expressions, and inspect the call stack while
 * execution is paused at a breakpoint.
 */

import * as vscode from "vscode";

// ── Helpers ──────────────────────────────────────────────────────────

function textResult(value: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(value),
  ]);
}

function getActiveMaximaDebugSession(): vscode.DebugSession | undefined {
  const session = vscode.debug.activeDebugSession;
  if (session && session.type === "maxima") {
    return session;
  }
  return undefined;
}

// ── Input types ──────────────────────────────────────────────────────

interface DebugEvaluateInput {
  expression: string;
}

// ── Tool: maxima_debug_variables ─────────────────────────────────────

class DebugVariablesTool implements vscode.LanguageModelTool<object> {
  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<object>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const session = getActiveMaximaDebugSession();
    if (!session) {
      return textResult("No active Maxima debug session.");
    }

    try {
      const stack = await session.customRequest("stackTrace", {
        threadId: 1,
      });

      if (!stack.stackFrames || stack.stackFrames.length === 0) {
        return textResult(
          "No stack frames available. The program may not be paused at a breakpoint.",
        );
      }

      const topFrame = stack.stackFrames[0];
      const scopesResponse = await session.customRequest("scopes", {
        frameId: topFrame.id,
      });

      const results: Array<{
        scope: string;
        variables: Array<{ name: string; value: string; type?: string }>;
      }> = [];

      for (const scope of scopesResponse.scopes) {
        const varsResponse = await session.customRequest("variables", {
          variablesReference: scope.variablesReference,
        });
        results.push({
          scope: scope.name,
          variables: varsResponse.variables.map(
            (v: { name: string; value: string; type?: string }) => ({
              name: v.name,
              value: v.value,
              type: v.type,
            }),
          ),
        });
      }

      return textResult(JSON.stringify(results, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`Failed to get variables: ${message}`);
    }
  }

  prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<object>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return { invocationMessage: "Reading debug variables\u2026" };
  }
}

// ── Tool: maxima_debug_evaluate ──────────────────────────────────────

class DebugEvaluateTool
  implements vscode.LanguageModelTool<DebugEvaluateInput>
{
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<DebugEvaluateInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const session = getActiveMaximaDebugSession();
    if (!session) {
      return textResult("No active Maxima debug session.");
    }

    try {
      const stack = await session.customRequest("stackTrace", {
        threadId: 1,
      });

      if (!stack.stackFrames || stack.stackFrames.length === 0) {
        return textResult(
          "No stack frames available. The program may not be paused at a breakpoint.",
        );
      }

      const topFrame = stack.stackFrames[0];
      const result = await session.customRequest("evaluate", {
        expression: options.input.expression,
        context: "repl",
        frameId: topFrame.id,
      });

      return textResult(result.result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`Evaluation failed: ${message}`);
    }
  }

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<DebugEvaluateInput>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Evaluating: ${options.input.expression}`,
    };
  }
}

// ── Tool: maxima_debug_callstack ─────────────────────────────────────

class DebugCallstackTool implements vscode.LanguageModelTool<object> {
  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<object>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const session = getActiveMaximaDebugSession();
    if (!session) {
      return textResult("No active Maxima debug session.");
    }

    try {
      const stack = await session.customRequest("stackTrace", {
        threadId: 1,
      });

      if (!stack.stackFrames || stack.stackFrames.length === 0) {
        return textResult("No stack frames available.");
      }

      const frames = stack.stackFrames.map(
        (f: { name: string; source?: { path?: string }; line: number }) => ({
          name: f.name,
          source: f.source?.path ?? null,
          line: f.line,
        }),
      );

      return textResult(JSON.stringify(frames, null, 2));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`Failed to get call stack: ${message}`);
    }
  }

  prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<object>,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.PreparedToolInvocation> {
    return { invocationMessage: "Reading debug call stack\u2026" };
  }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerDebugLmTools(): vscode.Disposable[] {
  return [
    vscode.lm.registerTool(
      "maxima_debug_variables",
      new DebugVariablesTool(),
    ),
    vscode.lm.registerTool(
      "maxima_debug_evaluate",
      new DebugEvaluateTool(),
    ),
    vscode.lm.registerTool(
      "maxima_debug_callstack",
      new DebugCallstackTool(),
    ),
  ];
}
