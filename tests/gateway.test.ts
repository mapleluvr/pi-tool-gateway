import test from "node:test";
import assert from "node:assert/strict";
import promises, { appendFile, link, readFile, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createExtension } from "../index.ts";
import { createBackendStateStore } from "../src/state.ts";
import { MxcRuntimeUnavailable } from "../src/mxc/runtime.ts";
import { backends, createMxcFixture, pwsh, smallPng } from "./helpers/mxc-fixture.ts";

// These tests isolate only the external runner for mode/control failure cases;
// real MXC and real Pi loader tests are separate acceptance gates.
function fakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const flags = new Map<string, unknown>();
  const registrations = new Map<string, number>();
  return {
    tools, commands, handlers, flags, registrations,
    registerTool(tool: any) { tools.set(tool.name, tool); registrations.set(tool.name, (registrations.get(tool.name) ?? 0) + 1); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerFlag(name: string, flag: any) { flags.set(name, flag.default); },
    getFlag(name: string) { return flags.get(name); },
    getSettings() { return {}; },
    getAllTools() { return [...tools.values()]; },
    getActiveTools() { return [...tools.keys()]; },
    on(name: string, handler: any) { handlers.set(name, handler); },
  };
}
async function setup(
  gateway: Record<string, unknown>,
  run: (value: {
    pi: ReturnType<typeof fakePi>; ctx: any; fixture: Awaited<ReturnType<typeof createMxcFixture>>;
    notifications: string[]; statuses: string[];
  }) => Promise<void>,
  beforeStart?: (pi: ReturnType<typeof fakePi>, fixture: Awaited<ReturnType<typeof createMxcFixture>>) => Promise<void> | void,
) {
  const fixture = await createMxcFixture();
  const pi = fakePi();
  const notifications: string[] = [];
  const statuses: string[] = [];
  const ctx: any = {
    cwd: fixture.workspace,
    ui: {
      notify: (text: string) => notifications.push(text),
      setStatus: (_key: string, text: string) => statuses.push(text),
    },
  };
  try {
    assert.ok(pwsh, "Local gateway acceptance requires PowerShell 7");
    createExtension(pi as any, {
      stateStore: createBackendStateStore({ statePath: join(fixture.dir, "shell.json") }),
      discoverBackends: () => backends, outputDir: join(fixture.dir, "logs"), gateway,
    } as any);
    await beforeStart?.(pi, fixture);
    await pi.handlers.get("session_start")?.({}, ctx);
    await run({ pi, ctx, fixture, notifications, statuses });
  } finally {
    await pi.handlers.get("session_shutdown")?.({}, ctx);
    await fixture.cleanup();
  }
}
const local = { skip: process.platform !== "win32" };

function fixtureRuntime(overrides: Record<string, unknown> = {}) {
  return {
    policyId: "control-fixture", workspace: "fixture", candidate: pwsh,
    async check() {}, async dispose() {},
    createExecutor() { return { candidate: pwsh, async exec() { return { exitCode: 0 }; } }; },
    async executeFile() { return { content: [{ type: "text", text: "fixture" }], details: undefined }; },
    ...overrides,
  };
}

test("disabled gateway preserves native startup and does not replace file tools", local, async () => {
  let checks = 0;
  await setup({ enabled: false, runtimeFactory: async () => { checks++; throw new Error("Must not load"); } }, async ({ pi, ctx, fixture }) => {
    assert.ok(pi.commands.has("mxc"), "Missing user MXC switch/status command");
    assert.equal(pi.tools.has("read"), false);
    assert.equal(pi.tools.has("write"), false);
    assert.equal(pi.tools.has("edit"), false);
    const user = await pi.handlers.get("user_bash")?.({ command: "anything" }, ctx);
    assert.equal(user, undefined);
    const result = await pi.tools.get("bash").execute("native", { command: "Write-Output 'NATIVE_GATEWAY_OK'", timeout: 10 }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /NATIVE_GATEWAY_OK/);
    assert.equal(checks, 0);
    assert.equal((await readFile(join(fixture.reference, "visible.txt"), "utf8")), "READ_ONLY_CANARY\n");
  });
});

test("a failed availability check hints and executes the original command once in ordinary pwsh", local, async () => {
  await setup({ enabled: true, runtimeFactory: async () => { throw new Error("runner unavailable fixture"); } }, async ({ pi, ctx, fixture, notifications, statuses }) => {
    assert.ok(pi.commands.has("mxc"), "MXC routing not registered");
    const marker = join(fixture.workspace, "fallback-count.txt");
    const result = await pi.tools.get("bash").execute(
      "fallback", { command: `Add-Content -LiteralPath '${marker}' -Value 'once'; Write-Output 'NATIVE_FALLBACK'`, timeout: 10 },
      undefined, undefined, ctx,
    );
    assert.match(result.content[0].text, /NATIVE_FALLBACK/);
    assert.match(result.content[0].text, /MXC 不可用/);
    assert.equal((await readFile(marker, "utf8")).trim(), "once");
    assert.ok(notifications.some((text) => /已切回普通 pwsh/.test(text) && /原生权限/.test(text)));
    assert.match(statuses.at(-1)!, /fallback|Native|普通/);
  });
});

test("native text fallback exposes its permission hint in the codemode value", local, async () => {
  await setup({ enabled: true, runtimeFactory: async () => { throw new Error("unavailable fixture"); } }, async ({ pi, ctx, fixture }) => {
    const text = await pi.tools.get("read").execute("text", { path: join(fixture.reference, "visible.txt") }, undefined, undefined, ctx);
    assert.match(text.structuredContent, /MXC 不可用/);
    assert.match(text.structuredContent, /原生权限/);
  });
});

test("native image fallback preserves image data and exposes its codemode permission hint", local, async () => {
  await setup({ enabled: true, runtimeFactory: async () => { throw new Error("unavailable fixture"); } }, async ({ pi, ctx, fixture }) => {
    const imagePath = join(fixture.outside, "fallback.png");
    await writeFile(imagePath, smallPng());
    const image = await pi.tools.get("read").execute("image", { path: imagePath }, undefined, undefined, ctx);
    assert.equal(image.structuredContent.type, "image");
    assert.match(image.structuredContent.note, /MXC 不可用/);
    assert.match(image.structuredContent.note, /原生权限/);
    assert.ok(image.structuredContent.data);
  });
});

test("permission denial is returned without falling through to the readable host file", local, async () => {
  await setup({ enabled: true, runtimeFactory: async () => fixtureRuntime({
    async executeFile() { const error = new Error("EACCES controlled denial"); (error as NodeJS.ErrnoException).code = "EACCES"; throw error; },
  }) }, async ({ pi, ctx, fixture, notifications, statuses }) => {
    assert.ok(pi.tools.has("read"), "Controlled file proxy not installed");
    await assert.rejects(pi.tools.get("read").execute("denied", { path: join(fixture.outside, "sentinel.txt") }, undefined, undefined, ctx), /EACCES/);
    assert.equal(await readFile(join(fixture.outside, "sentinel.txt"), "utf8"), "OUTSIDE_CANARY\n");
    assert.equal(notifications.some((text) => /已切回/.test(text)), false);
    assert.match(statuses.at(-1)!, /MXC/);
  });
});

test("a runtime error after a side effect is not replayed through native pwsh", local, async () => {
  let marker: string;
  await setup({ enabled: true, runtimeFactory: async () => fixtureRuntime({
    createExecutor() { return {
      candidate: pwsh,
      async exec() { await appendFile(marker, "once\n"); throw new MxcRuntimeUnavailable("transport lost after effect; no replay"); },
    }; },
  }) }, async ({ pi, ctx, fixture, notifications }) => {
    assert.ok(pi.commands.has("mxc"), "MXC gateway missing");
    marker = join(fixture.workspace, "ambiguous-effect.txt");
    await assert.rejects(pi.tools.get("bash").execute(
      "partial", { command: `Add-Content -LiteralPath '${marker}' -Value 'once'`, timeout: 10 }, undefined, undefined, ctx,
    ), /transport lost|no replay/);
    assert.equal((await readFile(marker, "utf8")).trim(), "once");
    assert.ok(notifications.some((text) => /已切回普通 pwsh/.test(text)));
  });
});

test("file proxy retains Pi 1.4 edit[] parameters and legacy preparation", local, async () => {
  await setup({ enabled: true, runtimeFactory: async () => { throw new Error("controlled unavailable"); } }, async ({ pi, ctx, fixture }) => {
    const edit = pi.tools.get("edit");
    assert.ok(edit, "Missing file override");
    assert.ok(edit.parameters.properties.edits);
    const target = join(fixture.workspace, "legacy-preparation.txt");
    await writeFile(target, "before\n");
    const args = edit.prepareArguments({ path: target, oldText: "before", newText: "after" });
    await edit.execute("prepared", args, undefined, undefined, ctx);
    assert.equal(await readFile(target, "utf8"), "after\n");
  });
});

test("late MXC activation installs one tool group and switching off restores native execution bodies", local, async () => {
  await setup({ enabled: false, runtimeFactory: async () => fixtureRuntime() }, async ({ pi, ctx, fixture, statuses }) => {
    const command = pi.commands.get("mxc");
    assert.ok(command, "Missing MXC command");
    assert.equal(pi.tools.has("write"), false);
    await command.handler("on", ctx);
    for (const name of ["read", "write", "edit"]) assert.ok(pi.tools.has(name));
    assert.match(statuses.at(-1)!, /MXC/);
    await command.handler("off", ctx);
    const target = join(fixture.workspace, "native-after-off.txt");
    await pi.tools.get("write").execute("native-write", { path: target, content: "NATIVE_BODY_OK" }, undefined, undefined, ctx);
    assert.equal(await readFile(target, "utf8"), "NATIVE_BODY_OK");
    assert.match(statuses.at(-1)!, /Native|普通/);
  });
});

test("an off preference cancels an earlier lazy activation before it can re-enable MXC", local, async () => {
  await setup({ enabled: false, runtimeFactory: async () => fixtureRuntime() }, async ({ pi, ctx, statuses, fixture }) => {
    const on = pi.commands.get("mxc").handler("on", ctx);
    const off = pi.commands.get("mxc").handler("off", ctx);
    await Promise.all([on, off]);
    assert.match(statuses.at(-1)!, /files: Native/);
    const target = join(fixture.outside, "latest-preference.txt");
    await pi.tools.get("write").execute("latest", { path: target, content: "LAST_PREFERENCE_NATIVE" }, undefined, undefined, ctx);
    assert.equal(await readFile(target, "utf8"), "LAST_PREFERENCE_NATIVE");
  });
});

test("concurrent lazy activations register one complete file tool group", local, async () => {
  await setup({ enabled: false, runtimeFactory: async () => fixtureRuntime() }, async ({ pi, ctx }) => {
    await Promise.all([pi.commands.get("mxc").handler("on", ctx), pi.commands.get("mxc").handler("on", ctx)]);
    for (const name of ["read", "write", "edit"]) assert.equal(pi.registrations.get(name), 1, `${name} was redundantly installed`);
  });
});

test("the MXC CLI preference is read at session startup rather than extension factory time", local, async () => {
  await setup({ runtimeFactory: async () => fixtureRuntime() }, async ({ pi, statuses }) => {
    assert.ok(pi.tools.has("read"), "Startup flag did not install MXC file routing");
    assert.match(statuses.at(-1)!, /MXC/);
  }, (pi) => { pi.flags.set("mxc", true); });
});

test("user ! and !! operation handlers use the pinned MXC executor", local, async () => {
  await setup({ enabled: true, runtimeFactory: async () => fixtureRuntime({
    createExecutor() { return { candidate: pwsh, async exec(_command: string, _cwd: string, options: any) {
      options.onData(Buffer.from("USER_MXC_ROUTE")); return { exitCode: 0 };
    } }; },
  }) }, async ({ pi, ctx, fixture }) => {
    const result = await pi.handlers.get("user_bash")?.({ command: "ignored", excludeFromContext: true }, ctx);
    assert.ok(result?.operations, "Native user-bash escape path is still active");
    let output = "";
    const outcome = await result.operations.exec("Write-Output 'USER_MXC_ROUTE'", fixture.workspace, {
      onData: (data: Buffer) => { output += data.toString("utf8"); },
    });
    assert.equal(outcome.exitCode, 0);
    assert.equal(output, "USER_MXC_ROUTE");
  });
});

test("background launch pins MXC identity across a later native-mode switch", local, async () => {
  await setup({ enabled: true, runtimeFactory: async () => fixtureRuntime({
    createExecutor() { return { candidate: pwsh, async exec(_command: string, _cwd: string, options: any) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      options.onData(Buffer.from("PINNED_MXC_OUTPUT")); return { exitCode: 0 };
    } }; },
  }) }, async ({ pi, ctx }) => {
    const launched = await pi.tools.get("bg_run").execute("start", { command: "Write-Output 'native wrong route'" }, undefined, undefined, ctx);
    await pi.commands.get("mxc").handler("off", ctx);
    const status = await pi.tools.get("bg_status").execute("status", { taskId: launched.details.taskId }, undefined, undefined, ctx);
    assert.equal(status.details.execution.mode, "mxc");
    assert.equal(status.details.execution.policyId, "control-fixture");
    const joined = await pi.tools.get("bg_join").execute("join", { taskId: launched.details.taskId, timeoutSeconds: 5 }, undefined, undefined, ctx);
    assert.match(joined.content[0].text, /PINNED_MXC_OUTPUT/);
  });
});

test("file requests serialize across workers to preserve concurrent disjoint edits", local, async () => {
  await setup({ enabled: true, runtimeFactory: async () => fixtureRuntime({
    async executeFile(_tool: string, params: any) {
      const original = await readFile(params.path, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 30));
      const replacement = params.edits[0];
      await writeFile(params.path, original.replace(replacement.oldText, replacement.newText));
      return { content: [{ type: "text", text: "edited" }], details: undefined };
    },
  }) }, async ({ pi, ctx, fixture }) => {
    const target = join(fixture.workspace, "parallel.txt");
    await writeFile(target, "AB");
    const edit = pi.tools.get("edit");
    assert.ok(edit, "Missing worker routing");
    await Promise.all([
      edit.execute("one", { path: target, edits: [{ oldText: "A", newText: "a" }] }, undefined, undefined, ctx),
      edit.execute("two", { path: target, edits: [{ oldText: "B", newText: "b" }] }, undefined, undefined, ctx),
    ]);
    assert.equal(await readFile(target, "utf8"), "ab");
  });
});

test("an already-active powershell entry follows the controlled command route", local, async () => {
  await setup({ enabled: true, runtimeFactory: async () => fixtureRuntime({
    createExecutor() { return { candidate: pwsh, async exec(_command: string, _cwd: string, options: any) {
      options.onData(Buffer.from("CONTROLLED_POWERSHELL")); return { exitCode: 0 };
    } }; },
  }) }, async ({ pi, ctx }) => {
    const result = await pi.tools.get("powershell").execute("powershell", { command: "Write-Output 'controlled'" }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /CONTROLLED_POWERSHELL/);
    assert.doesNotMatch(result.content[0].text, /NATIVE_BYPASS/);
  }, (pi) => { pi.registerTool({ name: "powershell", async execute() { return { content: [{ type: "text", text: "NATIVE_BYPASS" }], details: undefined }; } }); });
});

test("selecting Git Bash immediately makes requested MXC inactive in the TUI", local, async () => {
  assert.ok(backends.some((candidate) => candidate.id === "gitbash"), "Local shell switch gate needs Git Bash");
  await setup({ enabled: true, runtimeFactory: async () => fixtureRuntime() }, async ({ pi, ctx, statuses }) => {
    await pi.commands.get("bash-select").handler("gitbash", ctx);
    assert.match(statuses.at(-1)!, /gitbash|Git Bash/i);
    assert.match(statuses.at(-1)!, /Native/);
    assert.doesNotMatch(statuses.at(-1)!, /files: MXC/);
  });
});

test("a late profile preflight cannot switch the gateway back to an old Shell", { ...local, timeout: 10_000 }, async () => {
  let profile = "";
  await setup({ runtimeFactory: async () => fixtureRuntime() }, async ({ pi, ctx, statuses }) => {
    const original = promises.stat;
    let permit!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>((resolve) => { permit = resolve; });
    const observed = new Promise<void>((resolve) => { entered = resolve; });
    let blocked = false;
    promises.stat = (async (path: any, options: any) => {
      if (String(path) === profile && !blocked) { blocked = true; entered(); await wait; }
      return original(path, options);
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      const oldCall = pi.tools.get("bash").execute("old-shell", { command: "fixture" }, undefined, undefined, ctx);
      const rejected = assert.rejects(oldCall, /configuration changed/i);
      await observed;
      await pi.commands.get("bash-select").handler("gitbash", ctx);
      permit();
      await rejected;
      assert.match(statuses.at(-1)!, /gitbash.*Native/i);
    } finally { permit(); promises.stat = original; syncBuiltinESMExports(); }
  }, async (pi, fixture) => {
    profile = join(fixture.dir, "late-profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, filesystem: {} }));
    pi.flags.set("mxc", true); pi.flags.set("mxc-policy", profile);
  });
});

for (const action of ["abort", "timeout"] as const) {
  test(`a blocked profile read respects ${action} before any model workload`, local, async () => {
    let profile = "";
    await setup({ checkTimeoutMs: 200, runtimeFactory: async () => fixtureRuntime() }, async ({ pi, ctx, notifications, fixture }) => {
      const original = promises.stat;
      let permit!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { permit = resolve; });
      const observed = new Promise<void>((resolve) => { entered = resolve; });
      let blocked = false;
      promises.stat = (async (path: any, options: any) => {
        if (String(path) === profile && !blocked) { blocked = true; entered(); await gate; }
        return original(path, options);
      }) as typeof original;
      syncBuiltinESMExports();
      const controller = new AbortController();
      const marker = join(fixture.workspace, "profile-workload.txt");
      const request = pi.tools.get("bash").execute("blocked", { command: `Set-Content -LiteralPath '${marker}' -Value 'ran'; Write-Output 'PROFILE_NATIVE_AFTER_TIMEOUT'`, timeout: 10 }, controller.signal, undefined, ctx);
      const completion = request.then((value: any) => ({ value }), (error: Error) => ({ error }));
      try {
        await observed;
        if (action === "abort") controller.abort();
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([completion, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Profile preparation ignored its bound or caller abort")), 1500); })]).finally(() => { if (timer) clearTimeout(timer); });
        if (action === "abort") {
          assert.ok("error" in result); assert.match(result.error.message, /aborted/i);
          await assert.rejects(readFile(marker), { code: "ENOENT" });
        } else {
          assert.ok("value" in result); assert.match(result.value.content[0].text, /PROFILE_NATIVE_AFTER_TIMEOUT/);
          assert.ok(notifications.some((text) => /MXC 不可用/.test(text) && /timed out/i.test(text)));
          assert.equal((await readFile(marker, "utf8")).trim(), "ran");
        }
      } finally { permit(); promises.stat = original; syncBuiltinESMExports(); await completion; }
    }, async (pi, fixture) => {
      profile = join(fixture.dir, "bounded-profile.json");
      await writeFile(profile, JSON.stringify({ version: 1, filesystem: {} }));
      pi.flags.set("mxc", true); pi.flags.set("mxc-policy", profile);
    });
  });
}

test("a policy profile inside the RW workspace cannot authorize the host gateway", local, async () => {
  await setup({ runtimeFactory: async () => fixtureRuntime() }, async ({ notifications, statuses }) => {
    assert.ok(notifications.some((text) => /MXC 不可用/.test(text) && /工作区|workspace/i.test(text)));
    assert.match(statuses.at(-1)!, /Native/);
  }, async (pi, fixture) => {
    const profile = join(fixture.workspace, "model-writable-profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, filesystem: { readonlyPaths: [fixture.reference] } }));
    pi.flags.set("mxc", true); pi.flags.set("mxc-policy", profile);
  });
});

test("a hard-linked policy cannot be modified through a workspace alias", local, async () => {
  await setup({ runtimeFactory: async () => fixtureRuntime() }, async ({ notifications, statuses }) => {
    assert.ok(notifications.some((text) => /MXC 不可用/.test(text) && /link|链接/i.test(text)));
    assert.match(statuses.at(-1)!, /Native/);
  }, async (pi, fixture) => {
    const profile = join(fixture.dir, "linked-profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, filesystem: {} }));
    await link(profile, join(fixture.workspace, "profile-alias.json"));
    pi.flags.set("mxc", true); pi.flags.set("mxc-policy", profile);
  });
});

test("changed policy contents are rechecked even when size and mtime are preserved", local, async () => {
  let profile = "";
  let deniedA = "";
  let deniedB = "";
  await setup({ runtimeFactory: async (options: any) => fixtureRuntime({
    createExecutor() { return { candidate: pwsh, async exec(_command: string, _cwd: string, options2: any) {
      options2.onData(Buffer.from(options.deniedPaths.includes(deniedB) ? "PROFILE_B" : "PROFILE_A"));
      return { exitCode: 0 };
    } }; },
  }) }, async ({ pi, ctx }) => {
    const before = await pi.tools.get("bash").execute("before", { command: "Write-Output unused" }, undefined, undefined, ctx);
    assert.match(before.content[0].text, /PROFILE_A/);
    await writeFile(profile, JSON.stringify({ version: 1, filesystem: { deniedPaths: [deniedB] } }));
    await utimes(profile, 1_700_000_000, 1_700_000_000);
    const after = await pi.tools.get("bash").execute("after", { command: "Write-Output unused" }, undefined, undefined, ctx);
    assert.match(after.content[0].text, /PROFILE_B/);
  }, async (pi, fixture) => {
    profile = join(fixture.dir, "preserved-time-profile.json");
    deniedA = join(fixture.reference, "A.txt"); deniedB = join(fixture.reference, "B.txt");
    await writeFile(profile, JSON.stringify({ version: 1, filesystem: { deniedPaths: [deniedA] } }));
    await utimes(profile, 1_700_000_000, 1_700_000_000);
    pi.flags.set("mxc", true); pi.flags.set("mxc-policy", profile);
  });
});

test("MXC cancellation reports pending until its executor acknowledges exit", local, async () => {
  let done!: (value: { exitCode: number }) => void;
  const completion = new Promise<{ exitCode: number }>((resolve) => { done = resolve; });
  await setup({ enabled: true, runtimeFactory: async () => fixtureRuntime({
    createExecutor() { return { candidate: pwsh, exec() { return completion; } }; },
  }) }, async ({ pi, ctx }) => {
    const launched = await pi.tools.get("bg_run").execute("start", { command: "fixture delayed exit" }, undefined, undefined, ctx);
    try {
      const stopped = await pi.tools.get("bg_kill").execute("stop", { taskId: launched.details.taskId }, undefined, undefined, ctx);
      assert.equal(stopped.details.status, "running", "A timer must not manufacture a successful kill");
      assert.match(stopped.content[0].text, /pending|not confirmed|未确认/i);
    } finally {
      done({ exitCode: 0 });
      await pi.tools.get("bg_join").execute("join", { taskId: launched.details.taskId, timeoutSeconds: 5 }, undefined, undefined, ctx);
    }
  });
});

test("an invalid trusted policy profile is an explicit pre-execution fallback", local, async () => {
  await setup({ runtimeFactory: async () => fixtureRuntime() }, async ({ pi, notifications, ctx }) => {
    assert.ok(notifications.some((text) => /MXC 不可用/.test(text) && /已切回普通 pwsh/.test(text)));
    const result = await pi.tools.get("bash").execute("profile", { command: "Write-Output 'PROFILE_NATIVE_OK'", timeout: 10 }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /PROFILE_NATIVE_OK/);
  }, async (pi, fixture) => {
    const profile = join(fixture.dir, "profile.json");
    await writeFile(profile, "{broken");
    pi.flags.set("mxc", true); pi.flags.set("mxc-policy", profile);
  });
});
