import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { test } from "vitest";

// Execute the page's shipped callbacks, not a second implementation of its
// request lifecycle. React setters and API responses are the test boundaries.
const source = ts.createSourceFile(
  "page.tsx",
  readFileSync(new URL("./page.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let loadCallback: ts.Node | undefined;
let resetCallback: ts.Node | undefined;
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(source) === "loadMcpRuns" &&
    node.initializer &&
    ts.isCallExpression(node.initializer)
  )
    loadCallback = node.initializer.arguments[0];
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "React.useEffect" &&
    node.arguments[0]?.getText(source).includes("mcpRequestIdRef.current +=")
  )
    resetCallback = node.arguments[0];
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(loadCallback);
assert.ok(resetCallback);

function compileCallback(node: ts.Node) {
  return ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const loadScript = compileCallback(loadCallback);
const resetScript = compileCallback(resetCallback);

function executeCallback(script: string, globals: Record<string, unknown>) {
  return vm.runInNewContext(script, globals) as () => Promise<void>;
}

test.each(["result", "error"])(
  "switching to all workspaces ends MCP loading and ignores a late %s",
  async (outcome) => {
    let resolve!: (value: { items: unknown[]; nextCursor: string }) => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<{ items: unknown[]; nextCursor: string }>(
      (done, fail) => {
        resolve = done;
        reject = fail;
      },
    );
    const state = {
      loading: false,
      runs: [] as unknown[],
      actions: [] as unknown[],
      cursor: null as string | null,
      error: null as string | null,
    };
    const ignore = () => {};
    const globals = {
      Error,
      MCP_RUN_LIMIT: 50,
      mcpRequestIdRef: { current: 0 },
      listRequestIdRef: { current: 0 },
      detailRequestIdRef: { current: 0 },
      loadTracesRef: { current: ignore },
      loadMcpRunsRef: { current: async () => {} },
      contentClient: {
        listWorkspaceMcpRuns: () => pending,
        listWorkspaceMcpActionRuns: async () => ({
          items: [{ id: "old-action" }],
        }),
      },
      t: (key: string) => key,
      setLoadingMcpRuns: (value: boolean) => {
        state.loading = value;
      },
      setMcpRuns: (value: unknown[] | ((current: unknown[]) => unknown[])) => {
        state.runs = typeof value === "function" ? value(state.runs) : value;
      },
      setMcpActionRuns: (value: unknown[]) => {
        state.actions = value;
      },
      setMcpNextCursor: (value: string | null) => {
        state.cursor = value;
      },
      setError: (value: string | null) => {
        state.error = value;
      },
      setTraces: ignore,
      setDetail: ignore,
      setSelectedTraceKey: ignore,
      setSelectedNode: ignore,
      setDrawerOpen: ignore,
      setNextCursor: ignore,
      setLoadingMoreObservations: ignore,
    };
    const oldRequest = executeCallback(loadScript, {
      ...globals,
      selectedWorkspaceId: "old-workspace",
    })();
    assert.equal(state.loading, true);
    globals.loadMcpRunsRef.current = executeCallback(loadScript, {
      ...globals,
      selectedWorkspaceId: null,
    });
    executeCallback(resetScript, globals)();
    const loadingAfterScopeChange = state.loading;
    if (outcome === "result")
      resolve({ items: [{ id: "old-run" }], nextCursor: "old-cursor" });
    else reject(new Error("old workspace failed"));
    await oldRequest;
    assert.equal(loadingAfterScopeChange, false);
    assert.equal(state.loading, false);
    assert.equal(state.runs.length, 0);
    assert.equal(state.actions.length, 0);
    assert.equal(state.cursor, null);
    assert.equal(state.error, null);
  },
);
