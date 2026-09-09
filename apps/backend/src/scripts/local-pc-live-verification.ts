import "dotenv/config";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { database, closeDatabase } from "@sourceweft/db";

assert(new URL(process.env.DATABASE_URL!).pathname.startsWith("/sourceweft_local_pc_e2e_"));
const root = new URL("../../../../output/playwright/local-pc/", import.meta.url);
const { runDirectory } = JSON.parse(await readFile(new URL("current-live-run.json", root), "utf8"));
const host = JSON.parse(await readFile(join(runDirectory, "host-ready.json"), "utf8"));
const threadId = process.argv[2];
assert(threadId && /^[\da-f-]{36}$/.test(threadId));
const marker = "WEB_LOCAL_E2E_5dcf5e35";
try {
  const thread = (await database.query("SELECT id,execution_target_json FROM threads WHERE id=$1", [threadId])).rows[0];
  assert.deepEqual(thread.execution_target_json, { kind: "local", deviceId: host.deviceId });
  const binding = (await database.query("SELECT thread_id,device_id,local_workspace_id,workspace_path FROM local_thread_bindings WHERE thread_id=$1", [threadId])).rows[0];
  assert.equal(binding.device_id, host.deviceId);
  assert(binding.workspace_path.startsWith(host.nativeData + "/task-workspaces/"));
  const file = join(binding.workspace_path, "browser-triggered.txt");
  assert.equal(await readFile(file, "utf8"), marker + "\n");
  const invocations = (await database.query("SELECT id,device_id,run_id,action,payload,status,result,error FROM local_tool_invocations WHERE thread_id=$1 ORDER BY created_at", [threadId])).rows;
  const execution = invocations.find((row: any) => row.action === "command.execute" && row.result?.exitCode === 0 && row.result?.output?.includes(marker));
  assert(execution, "A real successful native command must exist");
  assert.equal(execution.device_id, host.deviceId);
  assert.equal(execution.result.output, binding.workspace_path + "\n" + marker + "\n");
  const native = JSON.parse(execFileSync("sqlite3", ["-json", join(host.nativeData, "local-host/state.sqlite3"), "SELECT id,state,result FROM local_invocations"], { encoding: "utf8" }));
  const nativeExecution = native.find((row: any) => row.id === execution.id);
  assert.equal(nativeExecution.state, "done");
  assert.deepEqual(JSON.parse(nativeExecution.result), execution.result);
  const sandboxes = (await database.query("SELECT id,provider,provider_sandbox_id,status FROM agent_sandboxes WHERE thread_id=$1", [threadId])).rows;
  assert(sandboxes.length > 0);
  assert(sandboxes.every((row: any) => row.provider === "local" && row.provider_sandbox_id === binding.local_workspace_id));
  const messages = (await database.query("SELECT id,role,content,content_json FROM messages WHERE thread_id=$1", [threadId])).rows;
  assert(messages.some((row: any) => row.role === "assistant" && JSON.stringify(row).includes(marker) && JSON.stringify(row).includes(binding.workspace_path)));
  const report = {
    status: "passed", scope: "real-browser-agent-production-rust-host-seatbelt-file-conversation",
    uiEnrollmentCovered: false, enrollment: "isolated fixture via real authentication and enrollment endpoints",
    screenState: "CUA reported locked at test start; native host and independent browser worked",
    thread, binding, file, marker, execution, nativeExecution, sandboxes,
    incidentalFailures: invocations.filter((row: any) => row.result?.exitCode && row.result.exitCode !== 0),
    limitations: ["Native onboarding and folder picker remain untested", "Skill initialization attempted /skills and was denied", "Approval card displayed /workspace instead of native path"],
  };
  await writeFile(join(runDirectory, "execution-verification.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, threadId, deviceId: host.deviceId, invocationId: execution.id, file, provider: "local", incidentalFailures: report.incidentalFailures.length }));
} finally { await closeDatabase(); }
