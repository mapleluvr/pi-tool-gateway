import test from "node:test";
import assert from "node:assert/strict";
import promises, { readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createMxcRuntime } from "../src/mxc/runtime.ts";
import { withGateway } from "./helpers/gateway-fixture.ts";

const windows = { skip: process.platform !== "win32", timeout: 60_000 };
function accepted(notices: { text: string; kind: string }[]) { assert.ok(notices.length > 0); assert.equal(notices.some((notice) => notice.kind === "error"), false, JSON.stringify(notices)); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

// Listing native configuration must not turn diagnostics into an MXC startup.
test("paths remains available in native mode without loading an MXC runtime", windows, async () => {
  let loads = 0;
  await withGateway(async ({ command, fixture }) => {
    const list = await command("paths"); accepted(list);
    assert.ok(list.some((notice) => notice.text.includes(fixture.workspace) && /Native/.test(notice.text)));
    assert.equal(loads, 0);
  }, () => ({ enabled: false, runtimeFactory: async () => { loads++; throw new Error("Must remain unloaded"); } }));
});

// Catches list failure exactly when a user needs it to diagnose fallback.
test("paths still shows session roots when the trusted profile becomes invalid", windows, async () => {
  let profile = "";
  await withGateway(async ({ command, extra }) => {
    accepted(await command(`allow rw "${extra}"`));
    await writeFile(profile, "{invalid profile");
    const list = await command("paths");
    assert.ok(list.some((notice) => notice.text.includes(extra) && /Native/.test(notice.text)), JSON.stringify(list));
    assert.ok(list.some((notice) => /profile|JSON/i.test(notice.text)));
  }, async (fixture) => {
    profile = join(fixture.dir, "changing-profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, filesystem: {} }));
    return { policyPath: profile };
  });
});

test("a removed external directory can still have its session grant revoked", windows, async () => {
  await withGateway(async ({ command, extra, fixture }) => {
    accepted(await command(`allow rw "${extra}"`));
    await rm(extra, { recursive: true, force: true });
    accepted(await command(`revoke "${extra}"`));
    const list = (await command("paths")).map((notice) => notice.text).join("\n");
    assert.ok(list.split("\n").some((line) => /DENY/.test(line) && line.includes(extra)));
    await assert.rejects(readFile(join(extra, "anything")), { code: "ENOENT" });
    assert.equal(await readFile(join(fixture.reference, "visible.txt"), "utf8"), "READ_ONLY_CANARY\n");
  });
});

test("profile changes during candidate validation cannot install a stale grant", windows, async () => {
  const entered = deferred(); const release = deferred(); let profile = "";
  await withGateway(async ({ command, call, extra, fixture }) => {
    const attempt = command(`allow rw "${extra}"`);
    try {
      await Promise.race([entered.promise, attempt.then(() => assert.fail("Candidate validation was not entered"))]);
      await writeFile(profile, JSON.stringify({ version: 1, filesystem: { deniedPaths: [join(fixture.outside, "sentinel.txt")] } }));
      release.resolve();
      assert.ok((await attempt).some((notice) => notice.kind === "error" && /changed/i.test(notice.text)));
      await assert.rejects(call("write", { path: join(extra, "stale.txt"), content: "MUST_NOT_WRITE" }), /EACCES|EPERM|denied/i);
      assert.equal((await command("paths")).some((notice) => notice.text.includes(extra)), false);
    } finally { release.resolve(); await attempt; }
  }, async (fixture, extra) => {
    profile = join(fixture.dir, "fresh-profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, filesystem: {} }));
    return { policyPath: profile, runtimeFactory: async (options) => {
      const runtime = await createMxcRuntime(options);
      return options.readwritePaths?.includes(extra) ? { ...runtime, check: async (signal?: AbortSignal) => {
        entered.resolve(); await release.promise; await runtime.check(signal);
      } } : runtime;
    } };
  });
});

test("session replacement invalidates both a pending candidate and its queued directory command", windows, async () => {
  const entered = deferred(); const release = deferred();
  await withGateway(async ({ command, call, extra, fixture, restart }) => {
    const first = command(`allow rw "${extra}"`);
    const second = command(`allow ro "${fixture.outside}"`);
    try {
      await Promise.race([entered.promise, first.then(() => assert.fail("Candidate validation was not entered"))]);
      await restart(); release.resolve();
      assert.deepEqual(await first, [], "The replaced session must not receive the old candidate receipt");
      assert.deepEqual(await second, [], "The replaced session must not receive the old queued command receipt");
      await assert.rejects(call("read", { path: join(fixture.outside, "sentinel.txt") }), /EACCES|EPERM|denied/i);
      await assert.rejects(call("write", { path: join(extra, "stale.txt"), content: "MUST_NOT_WRITE" }), /EACCES|EPERM|denied/i);
    } finally { release.resolve(); await Promise.all([first, second]); }
  }, (_fixture, extra) => ({ runtimeFactory: async (options) => {
    const runtime = await createMxcRuntime(options);
    return options.readwritePaths?.includes(extra) ? { ...runtime, check: async (signal?: AbortSignal) => {
      entered.resolve(); await release.promise; await runtime.check(signal);
    } } : runtime;
  } }));
});

// The external checker is shortened only for this control-flow timing probe;
// the actual fs metadata operation is delayed, not a forged success response.
test("a stalled directory metadata lookup is bounded without switching the active mode", windows, async () => {
  await withGateway(async ({ command, call, extra }) => {
    const original = promises.stat; const entered = deferred(); const release = deferred();
    promises.stat = (async (path: any, options: any) => {
      if (String(path) === extra) { entered.resolve(); await release.promise; }
      return original(path, options);
    }) as typeof original;
    syncBuiltinESMExports();
    const attempt = command(`allow rw "${extra}"`);
    try {
      await Promise.race([entered.promise, attempt.then(() => assert.fail("The directory metadata boundary was not reached"))]);
      assert.ok((await attempt).some((notice) => notice.kind === "error" && /directory.*timed out/i.test(notice.text)));
    } finally { release.resolve(); promises.stat = original; syncBuiltinESMExports(); await attempt; }
    assert.equal((await call("bash", { command: "Write-Output 'STILL_MXC'", timeout: 10 })).details.execution.mode, "mxc");
  }, () => ({ checkTimeoutMs: 75, runtimeFactory: async (options) => ({ ...await createMxcRuntime(options), async check() {} }) }));
});
