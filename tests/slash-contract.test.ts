import test from "node:test";
import assert from "node:assert/strict";
import type { BackendCandidate } from "../src/backends.ts";
import { pwsh } from "./helpers/mxc-fixture.ts";
import { controlRuntime, deferred, withSlash } from "./helpers/slash-fixture.ts";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };
const text = (notices: { text: string }[]) => notices.map((notice) => notice.text).join("\n");
const nativeOnly: BackendCandidate = {
  id: "gitbash", kind: "bash", label: "Native-only fixture", path: process.execPath,
  args: ["-e"], commandTransport: "argv", version: "fixture",
};

test("an unchanged on still validates readiness before reporting no change", windows, async () => {
  let checks = 0;
  await withSlash(async ({ command, statuses }) => {
    await command("on");
    const report = text(await command("on"));
    assert.equal(checks, 2, "An unchanged request must not skip the required check");
    assert.match(report, /未发生变更.*MXC on/);
    assert.match(statuses.at(-1)!, /pwsh: MXC.*files: MXC/);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture, {
    async check() { checks++; },
  }) as any } }));
});

test("an unchanged preference whose recheck fails reports fallback instead of no change", windows, async () => {
  let checks = 0;
  await withSlash(async ({ command }) => {
    await command("on");
    const report = text(await command("on"));
    assert.match(report, /已回退/); assert.match(report, /second check fixture/);
    assert.doesNotMatch(report, /未发生变更/);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture, {
    async check() { if (++checks === 2) throw new Error("second check fixture"); },
  }) as any } }));
});

test("a noneligible Shell preserves the request and makes inactive MXC visible in the footer", windows, async () => {
  let loads = 0;
  await withSlash(async ({ command, statuses }) => {
    const report = text(await command("on"));
    assert.match(report, /请求.*保留|已保留.*请求/);
    assert.match(report, /不适用|不支持/);
    assert.match(report, /\/bash-select pwsh7/);
    assert.match(statuses.at(-1)!, /MXC.*(?:requested|请求)/i);
    assert.equal(loads, 0);
  }, () => ({ discoverBackends: () => [nativeOnly], gateway: { enabled: false,
    runtimeFactory: async () => { loads++; throw new Error("An ineligible Shell must not load MXC"); },
  } }));
});

test("a missing Shell is reported as nonexecutable rather than usable Native execution", windows, async () => {
  await withSlash(async ({ command }) => {
    const report = text(await command("status"));
    assert.match(report, /命令:?\s*不可执行/);
    assert.match(report, /文件:?\s*Native/);
    assert.match(text(await command("on")), /没有可用 Shell|不可执行/);
  }, () => ({ discoverBackends: () => [], gateway: { enabled: false } }));
});

test("normal command receipts stay concise while status retains diagnostic detail", windows, async () => {
  await withSlash(async ({ command }) => {
    const report = text(await command("on"));
    assert.match(report, /完成.*MXC on/);
    assert.ok(report.trim().split("\n").length <= 2, report);
    assert.doesNotMatch(report, /当前实际|请求:|下一步|workspace:|profile:|核心路由:/);
    const status = text(await command("status"));
    assert.match(status, /workspace:/); assert.match(status, /profile:/); assert.match(status, /覆盖边界:/);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("the menu identifies its workspace and the receipt names the chosen operation", windows, async () => {
  await withSlash(async ({ command, ctx, fixture }) => {
    let menuTitle = "";
    ctx.ui.select = async (title: string, values: string[]) => {
      menuTitle = title; return values.find((value) => value.startsWith("on "));
    };
    const report = text(await command(""));
    assert.ok(menuTitle.includes(fixture.workspace));
    assert.match(report.split("\n")[0], /MXC on|开启 MXC/);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture) as any } }));
});

test("Shell choices show MXC eligibility without treating eligibility as readiness", windows, async () => {
  await withSlash(async ({ pi, ctx, state }) => {
    let choices: string[] = [];
    ctx.ui.select = async (_title: string, values: string[]) => { choices = values; return undefined; };
    const before = state.read().selection;
    await pi.commands.get("bash-select").handler("", ctx);
    assert.match(choices.find((value) => /pwsh7/.test(value))!, /MXC.*(?:候选|检查|自检)/);
    assert.match(choices.find((value) => /gitbash/.test(value))!, /Native|不适用/);
    assert.deepEqual(state.read().selection, before);
  }, () => ({ discoverBackends: () => [pwsh!, nativeOnly], gateway: { enabled: false } }));
});

test("a completed help query cannot erase progress for an unrelated pending check", windows, async () => {
  const entered = deferred(); const release = deferred();
  await withSlash(async ({ command, widgets }) => {
    const pending = command("on");
    try {
      await Promise.race([entered.promise, pending.then(() => assert.fail("Checker never entered"))]);
      await command("help");
      assert.ok(widgets.size > 0, "The unfinished on operation lost its progress widget");
      assert.match([...widgets.values()].flat().join("\n"), /验证|检查/);
    } finally { release.resolve(); await pending; }
    assert.equal(widgets.size, 0);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture, {
    async check() { entered.resolve(); await release.promise; },
  }) as any } }));
});

test("receipt storage failure preserves the completed result and never repeats the operation", windows, async () => {
  let checks = 0;
  await withSlash(async ({ command, pi, statuses, widgets }) => {
    pi.appendEntry = () => { throw new Error("receipt storage fixture locked"); };
    const report = text(await command("on"));
    assert.match(report, /回执.*失败/); assert.match(report, /receipt storage fixture locked/);
    assert.match(report, /完成.*MXC on/);
    assert.match(statuses.at(-1)!, /files: MXC/);
    assert.equal(checks, 1); assert.equal(widgets.size, 0);
  }, (fixture) => ({ gateway: { enabled: false, runtimeFactory: async () => controlRuntime(fixture, {
    async check() { checks++; },
  }) as any } }));
});
