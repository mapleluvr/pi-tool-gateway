import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createMxcFixture, pwsh } from "./helpers/mxc-fixture.ts";
import { killProcessTree } from "../src/operations.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const piRoot = getPackageDir();

test("the real bundled Pi 1.4 CLI keeps MXC user-bash control across a new session and reports fallback through RPC", { skip: process.platform !== "win32", timeout: 90_000 }, async () => {
  const fixture = await createMxcFixture();
  const candidatePath = pwsh?.path;
  assert.ok(candidatePath);
  const shell = await realpath(candidatePath).catch(async () => realpath(await readlink(candidatePath)));
  const agentDir = join(fixture.dir, "rpc-agent");
  const home = join(fixture.dir, "rpc-home");
  const temp = join(fixture.dir, "rpc-tmp");
  const evidence = join(root, "docs", ".temp", "evidence");
  await Promise.all([agentDir, home, temp, evidence, join(home, "AppData", "Local"), join(home, "AppData", "Roaming")].map((path) => mkdir(path, { recursive: true })));
  const profile = join(fixture.dir, "rpc-profile.json");
  await writeFile(profile, JSON.stringify({ version: 1, filesystem: { readonlyPaths: [fixture.reference], deniedPaths: [join(fixture.reference, "denied.txt")] } }));
  const system = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const env = {
    SYSTEMROOT: system, WINDIR: system, HOME: home, USERPROFILE: home,
    LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"), TEMP: temp, TMP: temp,
    ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)",
    PATH: [dirname(shell), dirname(process.execPath), join(system, "System32")].join(";"),
    PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", NO_COLOR: "1",
  };
  const child = spawn(process.execPath, [join(piRoot, "dist", "bundle", "cli.js"), "--mode", "rpc", "--no-extensions", "-e", root, "--mxc", "--mxc-policy", profile], { cwd: fixture.workspace, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  const messages: any[] = [];
  let stdout = "";
  let stderr = "";
  let partial = "";
  let sequence = 0;
  let closed: number | null | undefined;
  let processError: Error | undefined;
  const pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const observers = new Set<() => void>();
  const exit = new Promise<number | null>((resolve) => child.once("close", (code) => { closed = code; for (const notify of observers) notify(); resolve(code); }));
  child.once("error", (error) => { processError = error; for (const notify of observers) notify(); });
  child.stderr.on("data", (text: string) => { stderr += text; });
  child.stdout.on("data", (text: string) => {
    stdout += text; partial += text;
    for (;;) {
      const newline = partial.indexOf("\n");
      if (newline < 0) break;
      const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try { message = JSON.parse(line); }
      catch { processError = new Error(`Non-JSON CLI stdout: ${line}`); break; }
      messages.push(message);
      const request = pending.get(message.id);
      if (message.type === "response" && request) {
        pending.delete(message.id); clearTimeout(request.timer);
        message.success ? request.resolve(message.data) : request.reject(new Error(message.error));
      }
    }
    for (const notify of observers) notify();
  });
  function waitFor(predicate: () => boolean, timeout = 20_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { observers.delete(inspect); reject(new Error(`RPC observation timeout. ${stderr}\n${stdout.slice(-2500)}`)); }, timeout);
      function inspect() {
        if (processError || closed !== undefined) { clearTimeout(timer); observers.delete(inspect); reject(processError ?? new Error(`CLI exited ${closed}: ${stderr}`)); }
        else if (predicate()) { clearTimeout(timer); observers.delete(inspect); resolve(); }
      }
      observers.add(inspect); inspect();
    });
  }
  function send(type: string, args: Record<string, unknown> = {}): Promise<any> {
    const id = `gateway-rpc-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${type} response timeout: ${stderr}`)); }, 25_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ type, id, ...args })}\n`);
    });
  }
  function latestStatus(): string {
    return messages.filter((message) => message.type === "extension_ui_request" && message.method === "setStatus" && message.statusKey === "pi-tool-gateway").at(-1)?.statusText ?? "";
  }
  const sentinel = join(fixture.outside, "sentinel.txt").replaceAll("'", "''");
  const deniedCommand = `$ErrorActionPreference='Stop'; try { Get-Content -LiteralPath '${sentinel}'; Write-Output 'RPC_UNEXPECTED_READ' } catch { Write-Output 'RPC_MXC_DENIED' }`;
  try {
    await waitFor(() => /files: MXC/.test(latestStatus()));
    const denied = await send("bash", { command: deniedCommand, excludeFromContext: true });
    assert.match(denied.output, /RPC_MXC_DENIED/); assert.doesNotMatch(denied.output, /OUTSIDE_CANARY|RPC_UNEXPECTED_READ/);
    await send("prompt", { message: `/mxc allow ro "${fixture.outside}"` });
    const allowedRead = await send("bash", { command: deniedCommand, excludeFromContext: true });
    assert.match(allowedRead.output, /OUTSIDE_CANARY/); assert.doesNotMatch(allowedRead.output, /RPC_MXC_DENIED/);
    await send("prompt", { message: `/mxc allow rw "${fixture.outside}"` });
    const external = join(fixture.outside, "rpc-shared.txt");
    await send("bash", { command: `$ErrorActionPreference='Stop'; Set-Content -LiteralPath '${external}' -Value 'RPC_SESSION_RW'`, excludeFromContext: true });
    assert.equal((await readFile(external, "utf8")).trim(), "RPC_SESSION_RW");
    await send("prompt", { message: "/mxc paths" });
    assert.ok(messages.some((message) => message.method === "notify" && /session/.test(message.message) && message.message.includes(fixture.outside)));
    await send("prompt", { message: "/mxc off" });
    assert.match(latestStatus(), /files: Native/);
    await send("new_session");
    await waitFor(() => /files: MXC/.test(latestStatus()));
    const afterNew = await send("bash", { command: deniedCommand, excludeFromContext: true });
    assert.match(afterNew.output, /RPC_MXC_DENIED/);
    assert.equal((await readFile(external, "utf8")).trim(), "RPC_SESSION_RW", "Session replacement must not delete user directories");
    let ownedPid = 0;
    const from = messages.length;
    const running = send("bash", { command: "[Console]::WriteLine('RPC_MXC_PID=' + $PID); [Console]::Out.Flush(); while ($true) { Start-Sleep -Milliseconds 100 }", excludeFromContext: true });
    const runningObserved = running.then((value) => ({ value }), (error: Error) => ({ error }));
    await waitFor(() => {
      const text = messages.slice(from).filter((message) => message.type === "bash_execution_update").map((message) => message.delta).join("");
      const match = text.match(/RPC_MXC_PID=(\d+)/);
      if (match) ownedPid = Number(match[1]);
      return ownedPid > 0;
    });
    const before = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", `if (Get-Process -Id ${ownedPid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 3 }`], { stdio: "ignore", windowsHide: true });
    assert.equal(before.status, 0);
    await send("abort_bash");
    const stopped = await runningObserved;
    assert.ok("value" in stopped, "RPC abort did not finish normally"); assert.equal(stopped.value.cancelled, true);
    const after = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", `if (Get-Process -Id ${ownedPid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 3 }`], { stdio: "ignore", windowsHide: true });
    assert.equal(after.status, 3);
    await writeFile(profile, "{invalid trusted fixture");
    await send("prompt", { message: "/mxc retry" });
    assert.match(latestStatus(), /files: Native/);
    assert.ok(messages.some((message) => message.method === "notify" && /MXC 不可用.*已切回普通 pwsh.*原生权限/.test(message.message)));
    const native = await send("bash", { command: deniedCommand, excludeFromContext: true });
    assert.match(native.output, /OUTSIDE_CANARY/); assert.doesNotMatch(native.output, /RPC_MXC_DENIED/);
    assert.equal(await readFile(join(fixture.outside, "sentinel.txt"), "utf8"), "OUTSIDE_CANARY\n");
    assert.equal(messages.filter((message) => message.type === "message_start" && message.message?.role === "assistant").length, 0);
    child.stdin.end();
    assert.equal(await exit, 0, stderr);
  } finally {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("RPC fixture closed")); }
    pending.clear();
    if (closed === undefined) { killProcessTree(child); await exit; }
    await writeFile(join(evidence, "pi-bundled-cli-rpc.stdout.jsonl"), stdout);
    await writeFile(join(evidence, "pi-bundled-cli-rpc.stderr.log"), stderr);
    await fixture.cleanup();
  }
});
