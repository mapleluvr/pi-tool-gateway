import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createMxcRuntime } from "../src/mxc/runtime.ts";
import { withGateway } from "./helpers/gateway-fixture.ts";

const windows = { skip: process.platform !== "win32", timeout: 90_000 };
function accepted(notices: { text: string; kind: string }[]) {
  assert.ok(notices.length > 0, "The user must receive a grant result");
  assert.equal(notices.some((notice) => notice.kind === "error"), false, JSON.stringify(notices));
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

// Catches a list describing only the selected shell, or hiding native fallback.
test("paths lists permission roots and their origins rather than claiming whole-host isolation", windows, async () => {
  await withGateway(async ({ command, fixture }) => {
    const listed = await command("paths"); accepted(listed);
    const text = listed.map((notice) => notice.text).join("\n");
    assert.ok(text.includes(fixture.workspace)); assert.ok(text.includes(fixture.reference));
    assert.match(text, /RW/); assert.match(text, /RO/); assert.match(text, /DENY/);
    assert.match(text, /MXC/); assert.match(text, /private|私有/i);
  });
});

// Catches slash state that never reaches the real CLI/file-worker policy.
test("session RO to RW to revoked permissions govern the real file and pwsh paths", windows, async () => {
  await withGateway(async ({ command, call, fixture, extra, notices }) => {
    const path = join(extra, "shared.txt"); await writeFile(path, "BEFORE\n");
    await assert.rejects(call("read", { path }), /EACCES|EPERM|denied/i);
    accepted(await command(`allow ro "${extra}"`));
    assert.match((await call("read", { path })).structuredContent, /BEFORE/);
    await assert.rejects(call("write", { path, content: "RO_ESCAPE" }), /EACCES|EPERM|denied/i);
    assert.equal(await readFile(path, "utf8"), "BEFORE\n");
    accepted(await command(`allow rw "${extra}"`));
    await call("write", { path, content: "WRITE_OK\n" });
    await call("edit", { path, edits: [{ oldText: "WRITE_OK", newText: "EDIT_OK" }] });
    const commandResult = await call("bash", { command: `$ErrorActionPreference='Stop'; Add-Content -LiteralPath '${path}' -Value 'PWSH_OK'`, timeout: 10 });
    assert.equal(commandResult.details.execution.mode, "mxc");
    assert.match((await call("read", { path })).structuredContent, /EDIT_OK[\s\S]*PWSH_OK/);
    accepted(await command(`revoke "${extra}"`));
    await assert.rejects(call("read", { path }), /EACCES|EPERM|denied/i);
    await assert.rejects(call("write", { path, content: "REVOKE_ESCAPE" }), /EACCES|EPERM|denied/i);
    assert.match(await readFile(path, "utf8"), /EDIT_OK[\s\S]*PWSH_OK/);
    assert.equal(notices.some((notice) => /已切回普通 pwsh/.test(notice.text)), false);
    const listed = (await command("paths")).map((notice) => notice.text).join("\n");
    assert.ok(listed.split("\n").some((line) => /DENY/.test(line) && line.includes(extra)));
    assert.equal(await readFile(join(fixture.reference, "visible.txt"), "utf8"), "READ_ONLY_CANARY\n");
  });
});

test("canonical aliases update one session grant without lowercasing the user path", windows, async () => {
  await withGateway(async ({ command, call, extra }) => {
    const path = join(extra, "case.txt"); await writeFile(path, "CANONICAL");
    accepted(await command(`allow rw '${extra}'`));
    const alias = win32.toNamespacedPath(extra.toUpperCase());
    accepted(await command(`allow ro "${alias}"`));
    await assert.rejects(call("write", { path, content: "WRONG_RW" }), /EACCES|EPERM|denied/i);
    assert.match((await call("read", { path })).structuredContent, /CANONICAL/);
    const listed = (await command("paths")).map((notice) => notice.text).join("\n");
    const grants = listed.split("\n").filter((line) => /session|会话/i.test(line) && line.toLowerCase().includes(extra.toLowerCase()));
    assert.equal(grants.length, 1, listed); assert.match(grants[0], /RO/);
  });
});

test("an invalid RW candidate keeps the original MXC policy and does not trigger native fallback", windows, async () => {
  await withGateway(async ({ command, call, fixture, notices }) => {
    const before = await call("bash", { command: "Write-Output 'BEFORE'", timeout: 10 });
    const result = await command(`allow rw "${fixture.reference}"`);
    assert.ok(result.some((notice) => notice.kind === "error"));
    const after = await call("bash", { command: "Write-Output 'AFTER'", timeout: 10 });
    assert.equal(after.details.execution.mode, "mxc");
    assert.equal(after.details.execution.policyId, before.details.execution.policyId);
    assert.equal(notices.some((notice) => /已切回普通 pwsh/.test(notice.text)), false);
    accepted(await command(`allow ro "${fixture.outside}"`));
    assert.match((await call("read", { path: join(fixture.outside, "sentinel.txt") })).structuredContent, /OUTSIDE_CANARY/);
  });
});

test("the active trusted profile cannot be enclosed by an extra RW grant", windows, async () => {
  let profile = "";
  await withGateway(async ({ command, call, fixture, extra }) => {
    const original = await readFile(profile, "utf8");
    accepted(await command(`allow rw "${extra}"`));
    const result = await command(`allow rw "${fixture.outside}"`);
    assert.ok(result.some((notice) => notice.kind === "error" && /profile|protected|RW/i.test(notice.text)));
    await assert.rejects(call("write", { path: profile, content: "MUST_NOT_CHANGE" }), /EACCES|EPERM|denied/i);
    assert.equal(await readFile(profile, "utf8"), original);
  }, async (fixture) => {
    profile = join(fixture.outside, "trusted-profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, filesystem: {} }));
    return { policyPath: profile };
  });
});

test("malformed paths and attempts to revoke non-session roots leave accepted grants usable", windows, async () => {
  await withGateway(async ({ command, call, fixture, extra }) => {
    accepted(await command(`allow rw "${extra}"`));
    const path = join(extra, "keep.txt"); await call("write", { path, content: "KEEP" });
    for (const args of ["allow rw relative", `allow rw "${join(extra, "missing")}"`, `allow rw "${path}"`, `allow xx "${extra}"`, `revoke "${fixture.workspace}"`]) {
      assert.ok((await command(args)).some((notice) => notice.kind === "error"), args);
      assert.match((await call("read", { path })).structuredContent, /KEEP/);
    }
  });
});

test("concurrent directory commands preserve both accepted grants", windows, async () => {
  await withGateway(async ({ command, call, extra, fixture }) => {
    const second = join(fixture.dir, "second-shared"); await mkdir(second);
    const results = await Promise.all([command(`allow rw "${extra}"`), command(`allow rw "${second}"`)]);
    results.forEach(accepted);
    for (const root of [extra, second]) {
      const path = join(root, "accepted.txt"); await call("write", { path, content: "BOTH_PRESENT" });
      assert.equal(await readFile(path, "utf8"), "BOTH_PRESENT");
    }
  });
});

test("session replacement clears grants and revoked records without deleting directories", windows, async () => {
  await withGateway(async ({ command, call, extra, restart }) => {
    const path = join(extra, "persisted-file.txt"); await writeFile(path, "USER_OWNED");
    accepted(await command(`allow ro "${extra}"`));
    assert.match((await call("read", { path })).structuredContent, /USER_OWNED/);
    await restart();
    await assert.rejects(call("read", { path }), /EACCES|EPERM|denied/i);
    const list = (await command("paths")).map((notice) => notice.text).join("\n");
    assert.equal(list.includes(extra), false); assert.equal(await readFile(path, "utf8"), "USER_OWNED");
  });
});

test("explicit directory setup while MXC is off does not enable it or replace native file tools", windows, async () => {
  await withGateway(async ({ command, call, extra, statuses }) => {
    const path = join(extra, "native-prepared.txt"); await writeFile(path, "PREPARED");
    accepted(await command(`allow ro "${extra}"`));
    assert.match(statuses.at(-1) ?? "", /Native/);
    assert.equal((await call("bash", { command: "Write-Output 'STILL_NATIVE'", timeout: 10 })).details.execution.mode, "native");
    await command("on");
    assert.match((await call("read", { path })).structuredContent, /PREPARED/);
    await assert.rejects(call("write", { path, content: "NOT_RW" }), /EACCES|EPERM|denied/i);
  }, () => ({ enabled: false }));
});

test("a timed out candidate does not damage the working MXC lease", windows, async () => {
  await withGateway(async ({ command, call, extra, notices }) => {
    const before = await call("bash", { command: "Write-Output 'BEFORE'", timeout: 10 });
    const result = await command(`allow rw "${extra}"`);
    assert.ok(result.some((notice) => notice.kind === "error" && /timed out/i.test(notice.text)), JSON.stringify(result));
    const after = await call("bash", { command: "Write-Output 'AFTER'", timeout: 10 });
    assert.equal(after.details.execution.mode, "mxc"); assert.equal(after.details.execution.policyId, before.details.execution.policyId);
    assert.equal(notices.some((notice) => /已切回普通 pwsh/.test(notice.text)), false);
  }, (_fixture, extra) => ({ checkTimeoutMs: 10_000, runtimeFactory: async (options) => {
    const runtime = await createMxcRuntime(options);
    return options.readwritePaths?.includes(extra) ? { ...runtime, check: async (signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) reject(new Error("Candidate aborted"));
      else signal?.addEventListener("abort", () => reject(new Error("Candidate aborted")), { once: true });
    }) } : runtime;
  } }));
});

test("a late candidate cannot undo off or install a grant into the changed configuration", windows, async () => {
  const entered = deferred(); const release = deferred();
  await withGateway(async ({ command, call, extra, statuses }) => {
    const attempt = command(`allow rw "${extra}"`);
    try {
      await Promise.race([entered.promise, attempt.then(() => assert.fail("The real grant validation path was never reached"))]);
      await command("off"); release.resolve();
      assert.ok((await attempt).some((notice) => notice.kind === "info" && notice.text.startsWith("[被较新配置取代]")));
      assert.match(statuses.at(-1) ?? "", /Native/);
      await command("on");
      await assert.rejects(call("write", { path: join(extra, "stale.txt"), content: "MUST_NOT_WRITE" }), /EACCES|EPERM|denied/i);
    } finally { release.resolve(); await attempt; }
  }, (_fixture, extra) => ({ runtimeFactory: async (options) => {
    const runtime = await createMxcRuntime(options);
    return options.readwritePaths?.includes(extra) ? { ...runtime, check: async (signal?: AbortSignal) => {
      entered.resolve(); await release.promise; await runtime.check(signal);
    } } : runtime;
  } }));
});

test("revocation rejects a retained file-object alias instead of losing the protected identity", windows, async () => {
  await withGateway(async ({ command, call, fixture, extra }) => {
    const source = join(extra, "shared-object.txt"); const alias = join(fixture.workspace, "retained-alias.txt");
    await writeFile(source, "SHARED_OBJECT"); await link(source, alias);
    accepted(await command(`allow rw "${extra}"`));
    const refused = await command(`revoke "${extra}"`);
    assert.ok(refused.some((notice) => notice.kind === "error" && /hard.link|file object/i.test(notice.text)), JSON.stringify(refused));
    assert.equal((await call("bash", { command: "Write-Output 'KEPT_MXC'", timeout: 10 })).details.execution.mode, "mxc");
    assert.match((await call("read", { path: source })).structuredContent, /SHARED_OBJECT/);
    await unlink(alias);
    accepted(await command(`revoke "${extra}"`));
    await assert.rejects(call("read", { path: source }), /EACCES|EPERM|denied/i);
    assert.equal(await readFile(source, "utf8"), "SHARED_OBJECT");
  });
});

test("revoking a path lists the still-running old-policy task and does not migrate its permissions", windows, async () => {
  await withGateway(async ({ command, call, fixture, extra }) => {
    accepted(await command(`allow rw "${extra}"`));
    const ready = join(fixture.workspace, "task-ready.txt"); const release = join(fixture.workspace, "task-release.txt");
    const target = join(extra, "old-policy.txt");
    const task = await call("bg_run", { command: `$ErrorActionPreference='Stop'; Set-Content -LiteralPath '${ready}' -Value $PID; $deadline=[DateTime]::UtcNow.AddSeconds(40); while(-not (Test-Path -LiteralPath '${release}')) { if([DateTime]::UtcNow -gt $deadline) {throw 'fixture release timeout'}; Start-Sleep -Milliseconds 50 }; Set-Content -LiteralPath '${target}' -Value 'OLD_LEASE_COMPLETED'` });
    try {
      const deadline = Date.now() + 10_000;
      while (!(await stat(ready).then(() => true, () => false))) { assert.ok(Date.now() < deadline, "The actual pwsh did not start"); await delay(25); }
      const revoked = await command(`revoke "${extra}"`); accepted(revoked);
      assert.ok(revoked.some((notice) => notice.text.includes(task.details.taskId)), JSON.stringify(revoked));
      const list = (await command("paths")).map((notice) => notice.text).join("\n");
      assert.ok(list.includes(task.details.taskId)); assert.match(list, /bg_kill/);
      await assert.rejects(call("write", { path: target, content: "NEW_LEASE_ESCAPE" }), /EACCES|EPERM|denied/i);
      await writeFile(release, "release");
      await call("bg_join", { taskId: task.details.taskId, timeoutSeconds: 15 });
      assert.match(await readFile(target, "utf8"), /OLD_LEASE_COMPLETED/);
      const snapshot = await call("bg_status", { taskId: task.details.taskId });
      assert.equal(snapshot.details.execution.policyId, task.details.execution.policyId);
    } finally { await writeFile(release, "release"); await call("bg_kill", { taskId: task.details.taskId }); }
  });
});
