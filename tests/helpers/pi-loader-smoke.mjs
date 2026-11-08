import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { inspectProcess, sameProcess } from "./process-identity.ts";
import { setTimeout as delay } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const input = JSON.parse(process.argv[2]);
const sdk = await import(pathToFileURL(join(input.piPackageRoot, "dist", "index.js")).href);
const { killProcessTree } = await import(pathToFileURL(join(input.extensionRoot, "src", "operations.ts")).href);
const settingsManager = sdk.SettingsManager.inMemory({
  defaultTools: ["+powershell"], compaction: { enabled: false }, retry: { enabled: false },
});
const loader = new sdk.DefaultResourceLoader({
  cwd: input.workspace, agentDir: input.agentDir, settingsManager,
  noExtensions: true, additionalExtensionPaths: [input.extensionRoot],
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, [], "Real extension loading failed");
const { session } = await sdk.createAgentSession({
  cwd: input.workspace, agentDir: input.agentDir, resourceLoader: loader, settingsManager,
  sessionManager: sdk.SessionManager.inMemory(input.workspace),
});
const statuses = [];
const notifications = [];
const observations = [];
const stops = [];
const errors = [];
session.extensionRunner.onError((error) => errors.push(error));
session.extensionRunner.setFlagValue("mxc", true);
session.extensionRunner.setFlagValue("mxc-policy", input.policyPath);
const ui = {
  ...session.extensionRunner.getUIContext(),
  setStatus(key, text) { statuses.push({ key, text }); },
  notify(text, kind) { notifications.push({ text, kind }); },
};
let callIndex = 0;
// Execute the actual loaded AgentTool, with its retained prepareArguments.
// This validates loader/registration/execution, not a model-issued nested call.
async function call(name, args, expectedError = false) {
  const tool = session.agent.state.tools.find((item) => item.name === name);
  assert.ok(tool, `Missing active loaded tool: ${name}`);
  const prepared = tool.prepareArguments ? await tool.prepareArguments(args) : args;
  let result;
  try {
    result = await tool.execute(`gateway-load-${++callIndex}`, prepared, undefined, undefined);
  } catch (error) {
    if (!expectedError) throw error;
    observations.push({ name, isError: true, error: error.message });
    return undefined;
  }
  observations.push({ name, isError: false, result });
  assert.equal(expectedError, false, `${name} unexpectedly succeeded`);
  return result;
}

async function verifyRegisteredStop(mode) {
  // Same executable, outside the gateway Registry: a broad process-name kill
  // would fail this host-side negative control. This child inherits only the
  // credential-free environment supplied by the parent fixture.
  const bystander = spawn(input.shell, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"], {
    cwd: input.workspace, env: process.env, stdio: "ignore", shell: false, windowsHide: true,
  });
  const closed = new Promise((resolve) => bystander.once("close", resolve));
  let id;
  try {
    await new Promise((resolve, reject) => { bystander.once("spawn", resolve); bystander.once("error", reject); });
    assert.ok(bystander.pid);
    const task = await call("bg_run", {
      name: `real-${mode}-slash-stop`,
      command: "[Console]::WriteLine('SLASH_TASK_PID=' + $PID); [Console]::Out.Flush(); while ($true) { Start-Sleep -Milliseconds 100 }",
    });
    id = task.details.taskId;
    assert.equal(task.details.execution.mode, mode);
    let pid;
    const deadline = Date.now() + 12_000;
    while (!pid && Date.now() < deadline) {
      const output = (await call("bg_logs", { taskId: id, maxBytes: 2000 })).content[0].text;
      const match = /SLASH_TASK_PID=(\d+)\r?\n/.exec(output);
      if (match) pid = Number(match[1]);
      else await delay(50);
    }
    assert.ok(pid, "The actual executor never emitted its PID");
    const targetBefore = inspectProcess(input.shell, pid, process.env);
    const bystanderBefore = inspectProcess(input.shell, bystander.pid, process.env);
    assert.ok(targetBefore.observed); assert.ok(bystanderBefore.observed);
    const rejected = notifications.length;
    await session.prompt(`/mxc stop ${id.slice(0, 4)}`);
    await session.prompt(`/mxc stop ${bystander.pid}`);
    assert.equal(notifications.slice(rejected).filter((notice) => /未知任务/.test(notice.text)).length, 2);
    assert.equal(sameProcess(targetBefore.observed, inspectProcess(input.shell, pid, process.env).observed), true, "Rejected prefix/PID must not cancel the registered target");
    const before = notifications.length;
    await session.prompt(`/mxc stop ${id}`);
    const receipt = notifications.slice(before).map((notice) => notice.text).join("\n");
    if (mode === "mxc") assert.match(receipt, /退出已确认/);
    else {
      assert.match(receipt, /退出尚未确认/);
      assert.doesNotMatch(receipt, /退出已确认|退出确认: 已确认/);
      const from = notifications.length;
      await session.prompt("/mxc tasks");
      assert.ok(notifications.slice(from).some((notice) => notice.text.includes(id) && /未确认/.test(notice.text)));
    }
    assert.equal((await call("bg_status", { taskId: id })).details.status, "killed");
    const targetAfter = inspectProcess(input.shell, pid, process.env);
    const bystanderAfter = inspectProcess(input.shell, bystander.pid, process.env);
    assert.equal(sameProcess(targetBefore.observed, targetAfter.observed), false, "Host creation identity must independently confirm target exit");
    assert.equal(sameProcess(bystanderBefore.observed, bystanderAfter.observed), true, "The original unregistered sibling Shell must survive");
    const again = notifications.length;
    await session.prompt(`/mxc stop ${id}`);
    assert.match(notifications.slice(again).map((notice) => notice.text).join("\n"), /早已结束/);
    stops.push({ mode, taskId: id, pid, bystanderPid: bystander.pid, targetBefore, targetAfter, bystanderBefore, bystanderAfter, pidGone: true, bystanderAlive: true, receipt });
  } finally {
    try { if (id) await call("bg_kill", { taskId: id }); }
    finally { killProcessTree(bystander); await closed; }
  }
}

try {
  await session.bindExtensions({ uiContext: ui, mode: "rpc" });
  assert.deepEqual(errors, [], "The real session_start handler failed");
  assert.match(statuses.at(-1)?.text ?? "", /files: MXC/, JSON.stringify(notifications));
  const file = join(input.workspace, "loaded.txt");
  await call("write", { path: file, content: "before\n中文 beta\n" });
  await call("edit", { path: file, oldText: "before", newText: "after" });
  const read = await call("read", { path: file });
  assert.match(read.structuredContent, /after\n中文 beta/);
  assert.equal(await readFile(file, "utf8"), "after\n中文 beta\n");
  await call("read", { path: join(input.outside, "sentinel.txt") }, true);
  await session.prompt("/mxc paths");
  assert.ok(notifications.some((notice) => notice.text.includes(input.workspace) && /RW/.test(notice.text)));
  await session.prompt(`/mxc allow ro "${input.outside}"`);
  assert.match((await call("read", { path: join(input.outside, "sentinel.txt") })).structuredContent, /OUTSIDE_CANARY/);
  const external = join(input.outside, "loaded-external.txt");
  await call("write", { path: external, content: "RO_MUST_DENY" }, true);
  await session.prompt(`/mxc allow rw "${input.outside}"`);
  await call("write", { path: external, content: "LOADED_EXTERNAL_BEFORE\n" });
  await call("edit", { path: external, edits: [{ oldText: "BEFORE", newText: "AFTER" }] });
  assert.match((await call("read", { path: external })).structuredContent, /LOADED_EXTERNAL_AFTER/);
  await session.prompt(`/mxc revoke "${input.outside}"`);
  await call("read", { path: external }, true);
  assert.equal(await readFile(external, "utf8"), "LOADED_EXTERNAL_AFTER\n");
  assert.match(statuses.at(-1)?.text ?? "", /files: MXC/);
  await call("write", { path: join(input.reference, "visible.txt"), content: "ESCAPED" }, true);
  assert.equal(await readFile(join(input.reference, "visible.txt"), "utf8"), "READ_ONLY_CANARY\n");
  const bash = await call("bash", { command: "Write-Output 'SDK_MXC_BASH'", timeout: 10 });
  assert.equal(bash.details.execution.mode, "mxc");
  assert.match(bash.content[0].text, /SDK_MXC_BASH/);
  const powershell = await call("powershell", { command: "Write-Output 'SDK_MXC_POWERSHELL'" });
  assert.match(powershell.content[0].text, /SDK_MXC_POWERSHELL/);
  const userCommand = "Write-Output 'SDK_MXC_USER_BASH'";
  const userRoute = await session.extensionRunner.emitUserBash({
    type: "user_bash", command: userCommand, excludeFromContext: true, cwd: input.workspace,
  });
  assert.ok(userRoute?.operations, "The actual user-bash handler did not provide controlled operations");
  const user = await session.executeBash(userCommand, undefined, { excludeFromContext: true, operations: userRoute.operations });
  observations.push({ name: "user_bash", result: user });
  assert.equal(user.exitCode, 0);
  assert.match(user.output, /SDK_MXC_USER_BASH/);
  await verifyRegisteredStop("mxc");
  const background = await call("bg_run", { command: "Start-Sleep -Milliseconds 1000; Write-Output 'SDK_PINNED_MXC'" });
  await session.prompt("/mxc off");
  const status = await call("bg_status", { taskId: background.details.taskId });
  assert.equal(status.details.execution.mode, "mxc");
  const joined = await call("bg_join", { taskId: background.details.taskId, timeoutSeconds: 10 });
  assert.match(joined.content[0].text, /SDK_PINNED_MXC/);
  assert.match(statuses.at(-1)?.text ?? "", /files: Native/);
  await call("write", { path: join(input.outside, "native-after-off.txt"), content: "NATIVE_TOOL_BODY" });
  assert.equal(await readFile(join(input.outside, "native-after-off.txt"), "utf8"), "NATIVE_TOOL_BODY");
  await verifyRegisteredStop("native");
  assert.deepEqual(errors, []);
  assert.equal(session.messages.filter((message) => message.role === "assistant").length, 0, "The fixture must not request a model response");
  console.log(JSON.stringify({
    sdkVersion: sdk.VERSION, sdkRoot: sdk.getPackageDir(), loaded: loader.getExtensions().extensions.map((item) => item.resolvedPath),
    assistantMessages: session.messages.filter((message) => message.role === "assistant").length,
    environmentKeys: Object.keys(process.env), statuses, notifications, observations, stops, errors,
  }));
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
