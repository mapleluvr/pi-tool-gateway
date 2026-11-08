import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { controlRuntime, deferred, withSlash } from "./helpers/slash-fixture.ts";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };
const text = (notices: { text: string }[]) => notices.map((notice) => notice.text).join("\n");

// Help is discovery, not an implicit environment probe or permission grant.
test("help lists actionable syntax and scope without creating an MXC runtime", windows, async () => {
  let loads = 0;
  await withSlash(async ({ command }) => {
    const report = text(await command("help"));
    for (const entry of ["/mxc on", "/mxc off", "/mxc retry", "/mxc paths", "/mxc allow", "/mxc revoke", "/mxc tasks", "/mxc stop", "/bash-select"]) assert.ok(report.includes(entry), entry);
    assert.match(report, /会话/); assert.match(report, /宿主|未接入/);
    assert.match(report, /pwsh/); assert.equal(loads, 0);
  }, () => ({ gateway: { enabled: false, runtimeFactory: async () => { loads++; throw new Error("Help must not probe"); } } }));
});

test("mxc completion exposes operations and permission tokens with useful descriptions", windows, async () => {
  await withSlash(async ({ pi }) => {
    const command = pi.commands.get("mxc");
    assert.equal(typeof command.getArgumentCompletions, "function");
    const root = command.getArgumentCompletions("");
    for (const entry of ["on", "off", "status", "retry", "paths", "allow", "revoke", "tasks", "stop", "help"]) assert.ok(root.some((item: any) => item.value === entry), entry);
    assert.ok(root.every((item: any) => item.label !== item.value), "Completions should explain actions");
    assert.deepEqual(command.getArgumentCompletions("allow ").map((item: any) => item.value).sort(), ["allow ro", "allow rw"]);
    assert.deepEqual(command.getArgumentCompletions("allow rx"), []);
  });
});

test("empty mxc opens a safe menu and Escape makes no changes", windows, async () => {
  let loads = 0;
  await withSlash(async ({ ctx, command, widgets }) => {
    let choices: string[] = [];
    ctx.ui.select = async (_title: string, options: string[]) => { choices = options; return undefined; };
    const report = text(await command(""));
    assert.ok(choices.some((choice) => /on/.test(choice)));
    assert.ok(choices.some((choice) => /paths/.test(choice)));
    assert.match(report, /已取消/);
    assert.ok(report.trim().split("\n").length <= 2, report);
    assert.equal(loads, 0); assert.equal(widgets.size, 0);
  }, () => ({ gateway: { enabled: false, runtimeFactory: async () => { loads++; throw new Error("Menu must not probe"); } } }));
});

test("choosing on in the menu uses the same readiness path as the complete command", windows, async () => {
  await withSlash(async ({ ctx, command, statuses }) => {
    ctx.ui.select = async (_title: string, values: string[]) => values.find((value) => value.startsWith("on "));
    const report = text(await command(""));
    assert.match(report, /完成.*MXC on/);
    assert.match(statuses.at(-1)!, /pwsh: MXC.*files: MXC/);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("incomplete allow gathers an existing directory and previews canonical scope before commit", windows, async () => {
  await withSlash(async ({ fixture, command, ctx }) => {
    ctx.ui.input = async () => fixture.outside;
    let preview = "";
    ctx.ui.confirm = async (_title: string, body: string) => { preview = body; return true; };
    const report = text(await command("allow ro"));
    assert.ok(preview.includes(fixture.outside)); assert.match(preview, /RO/);
    assert.match(preview, /会话/); assert.match(preview, /待.*MXC|启用 MXC 后生效/);
    assert.doesNotMatch(preview, /不迁移|不删除/);
    assert.match(report, /已登记/); assert.match(report, /待.*MXC|启用 MXC 后生效/);
    assert.ok(report.trim().split("\n").length <= 3, report);
    const paths = text(await command("paths"));
    assert.ok(paths.split("\n").some((row) => /RO.*session/.test(row) && row.includes(fixture.outside)));
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("cancelling the permission preview keeps session grants unchanged", windows, async () => {
  let checks = 0;
  await withSlash(async ({ fixture, command, ctx }) => {
    ctx.ui.input = async () => fixture.outside;
    ctx.ui.confirm = async () => false;
    assert.match(text(await command("allow rw")), /已取消/);
    assert.equal(text(await command("paths")).includes(fixture.outside), false);
    assert.equal(checks, 0);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => { checks++; return controlRuntime(fixture) as any; } } }));
});

test("a complete grant has no extra confirmation and explains registration versus enforcement", windows, async () => {
  await withSlash(async ({ fixture, command, ctx }) => {
    ctx.ui.confirm = async () => { throw new Error("Complete grants must not reprompt"); };
    const report = text(await command(`allow ro "${fixture.outside}"`));
    assert.match(report, /已登记/); assert.match(report, /启用 MXC 后生效/);
    assert.ok(report.includes(fixture.outside));
    assert.ok(report.trim().split("\n").length <= 3, report);
    assert.doesNotMatch(report, /MXC 已生效|当前实际|不迁移|不删除/);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("revoke with no directory selects only an active session grant and retains its contents", windows, async () => {
  await withSlash(async ({ fixture, command, ctx }) => {
    await command(`allow ro "${fixture.outside}"`);
    let choices: string[] = [];
    ctx.ui.select = async (_title: string, values: string[]) => { choices = values; return values.find((value) => value.includes(fixture.outside)); };
    ctx.ui.confirm = async () => true;
    const report = text(await command("revoke"));
    assert.equal(choices.some((value) => value.includes(fixture.workspace)), false);
    assert.match(report, /DENY/);
    assert.ok(report.includes(fixture.outside));
    assert.ok(report.trim().split("\n").length <= 3, report);
    assert.doesNotMatch(report, /不删除|内容保留|不迁移/);
    assert.equal(await readFile(join(fixture.outside, "sentinel.txt"), "utf8"), "OUTSIDE_CANARY\n");
    const list = text(await command("paths"));
    assert.ok(list.split("\n").some((row) => /DENY.*session/.test(row) && row.includes(fixture.outside)));
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("empty revoke is a meaningful no-change result rather than an invalid syntax error", windows, async () => {
  await withSlash(async ({ command, ctx }) => {
    ctx.ui.select = async () => { throw new Error("Empty grant list must not open a selector"); };
    const report = text(await command("revoke"));
    assert.match(report, /未发生变更|没有.*授权/);
    assert.match(report, /会话/);
    assert.ok(report.trim().split("\n").length <= 2, report);
  }, () => ({ gateway: { enabled: false } }));
});

test("revoke path completion preserves the full canonical directory with spaces", windows, async () => {
  await withSlash(async ({ fixture, command, pi }) => {
    const extra = join(fixture.dir, "Shared Temp 中文"); await mkdir(extra);
    await command(`allow ro "${extra}"`);
    assert.equal(typeof pi.commands.get("mxc").getArgumentCompletions, "function");
    const completions = pi.commands.get("mxc").getArgumentCompletions("revoke ");
    assert.ok(completions.some((item: any) => item.value === `revoke "${extra}"`));
    await command(`revoke "${extra}"`);
    assert.equal(pi.commands.get("mxc").getArgumentCompletions("revoke ").length, 0);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("paths details expands runtime resources while the default listing remains a summary", windows, async () => {
  const resource = "D:\\TrustedRuntime\\read-only";
  await withSlash(async ({ command, fixture }) => {
    const summary = text(await command("paths"));
    assert.ok(summary.includes(fixture.workspace));
    assert.equal(summary.includes(resource), false);
    assert.match(summary, /--details/);
    const detail = text(await command("paths --details"));
    assert.ok(detail.includes(resource)); assert.match(detail, /private|私有/);
    assert.match(detail, /RO/);
  }, (fixture) => ({ gateway: { enabled: true, runtimeFactory: async () => controlRuntime(fixture, {
    paths: { readonlyPaths: [fixture.reference, resource], readwritePaths: [fixture.workspace], deniedPaths: [], scratchRoot: fixture.options.scratchRoot },
  }) as any } }));
});

test("Native paths details explain unavailable runtime resources without starting MXC", windows, async () => {
  let loads = 0;
  await withSlash(async ({ command }) => {
    const report = text(await command("paths --details"));
    assert.match(report, /运行资源.*未建立/);
    assert.doesNotMatch(report, /--details 查看运行资源/);
    assert.equal(loads, 0);
  }, () => ({ gateway: { enabled: false, runtimeFactory: async () => { loads++; throw new Error("Native details must not start MXC"); } } }));
});

test("status explains the controlled core and does not claim that a late powershell tool is covered", windows, async () => {
  await withSlash(async ({ command, pi, ctx }) => {
    await command("on");
    const sdk = await import("@earendil-works/pi-coding-agent");
    pi.registerTool(sdk.createPowerShellToolDefinition(ctx.cwd));
    const report = text(await command("status"));
    assert.match(report, /read.*write.*edit/);
    assert.match(report, /powershell.*(?:未接管|Host)/i);
    assert.match(report, /MCP|LSP/); assert.match(report, /未接入|宿主/);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("a menu from an earlier session cannot enable MXC after session replacement", windows, async () => {
  let loads = 0; const entered = deferred(); const release = deferred();
  await withSlash(async ({ command, ctx, restart, widgets, statuses }) => {
    ctx.ui.select = async (_title: string, values: string[]) => { entered.resolve(); await release.promise; return values.find((value) => value.startsWith("on ")); };
    const pending = command("");
    try {
      await Promise.race([entered.promise, pending.then(() => assert.fail("Menu never opened"))]);
      await restart(); release.resolve(); await pending;
      assert.equal(loads, 0); assert.equal(widgets.size, 0);
      assert.match(statuses.at(-1)!, /Native/);
    } finally { release.resolve(); await pending; }
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => { loads++; return controlRuntime(fixture) as any; } } }));
});

test("a non-UI incomplete command fails with explicit parameters instead of waiting for a dialog", windows, async () => {
  await withSlash(async ({ ctx, pi, widgets }) => {
    ctx.hasUI = false; ctx.mode = "json";
    ctx.ui.select = async () => { throw new Error("No UI dialogs are permitted"); };
    await assert.rejects(pi.commands.get("mxc").handler("", ctx), /\/mxc (?:status|help)/);
    assert.equal(widgets.size, 0);
  });
});

// Cleanup failure is not evidence that an already committed grant was rolled back.
test("disposal failure after a directory commit reports registration rather than preserved old configuration", windows, async () => {
  await withSlash(async ({ command, fixture }) => {
    const report = text(await command(`allow ro "${fixture.outside}"`));
    assert.match(report, /已登记|已提交/);
    assert.match(report, /dispose cleanup fixture/);
    assert.doesNotMatch(report, /未提交目录候选|原会话目录配置保留/);
    assert.ok(text(await command("paths")).split("\n").some((row) => /RO.*session/.test(row) && row.includes(fixture.outside)));
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture, {
    async dispose() { throw new Error("dispose cleanup fixture"); },
  }) as any } }));
});
