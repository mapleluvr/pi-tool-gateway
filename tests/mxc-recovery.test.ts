import test from "node:test";
import assert from "node:assert/strict";
import promises, { copyFile, link, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMxcRuntime } from "../src/mxc/runtime.ts";
import { createMxcFixture } from "./helpers/mxc-fixture.ts";
import { lockFixtureFile } from "./helpers/file-lock.ts";

const windows = { skip: process.platform !== "win32", timeout: 30_000 };

async function withUncheckedRuntime(run: (runtime: Awaited<ReturnType<typeof createMxcRuntime>>, fixture: Awaited<ReturnType<typeof createMxcFixture>>) => Promise<void>) {
  const fixture = await createMxcFixture();
  let runtime: Awaited<ReturnType<typeof createMxcRuntime>> | undefined;
  try {
    runtime = await createMxcRuntime(fixture.options);
    await run(runtime, fixture);
  } finally {
    await runtime?.dispose();
    await fixture.cleanup();
  }
}

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 5_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function withAuditChurn(fixture: Awaited<ReturnType<typeof createMxcFixture>>, run: () => Promise<void>) {
  const preload = join(fixture.reference, "audit-churn-preload.mjs");
  await copyFile(fileURLToPath(new URL("./helpers/audit-churn-preload.mjs", import.meta.url)), preload);
  const original = promises.writeFile;
  // Instrument the already-generated, fixture-owned audit job only. No SDK
  // result or filesystem error is stubbed; the real MXC worker deletes the file.
  promises.writeFile = (async (path: any, data: any, options: any) => {
    if (typeof data === "string" && String(path).startsWith(fixture.options.scratchRoot) && String(path).endsWith("policy.json")) {
      const policy = JSON.parse(data);
      if (policy.process.commandLine.includes("file-worker.mjs")) {
        const request = JSON.parse(await readFile(join(dirname(String(path)), "request.json"), "utf8"));
        if (request.audit) {
          policy.process.env.push(`NODE_OPTIONS=--import=${pathToFileURL(preload).href}`);
          data = JSON.stringify(policy);
        }
      }
    }
    return original(path, data, options);
  }) as typeof original;
  syncBuiltinESMExports();
  try { await run(); }
  finally { promises.writeFile = original; syncBuiltinESMExports(); }
}

async function withCleanupLock(runtime: Awaited<ReturnType<typeof createMxcRuntime>>, fixture: Awaited<ReturnType<typeof createMxcFixture>>, holdMs: number | undefined, run: () => Promise<void>) {
  const original = promises.rm;
  // The native helper opens the actual completed job's policy.json with
  // FileShare.None. The production rm receives its real options and errno.
  promises.rm = (async (path: any, options: any) => {
    if (win32.dirname(String(path)).toLowerCase() !== win32.normalize(fixture.options.scratchRoot).toLowerCase()) {
      return original(path, options);
    }
    const lock = lockFixtureFile(runtime.candidate, join(String(path), "policy.json"), fixture.dir, holdMs);
    try { await bounded(lock.ready, "No actual Windows sharing lock appeared"); return await original(path, options); }
    finally { await lock.stop(); }
  }) as typeof original;
  syncBuiltinESMExports();
  try { await run(); }
  finally { promises.rm = original; syncBuiltinESMExports(); }
}

// Catches a rejected layout Promise being reused by a later, uncancelled call.
// The first call stops at a real trusted-resource metadata boundary; the next
// call must execute the production Pi read worker through the actual MXC CLI.
test("an aborted first layout audit does not poison a new real MXC file invocation", windows, async () => {
  await withUncheckedRuntime(async (runtime, fixture) => {
    const target = join(fixture.workspace, "recovery.txt");
    await writeFile(target, "RECOVERY_CANARY\n");
    const original = promises.lstat;
    const metadataPath = win32.normalize(fixture.options.deniedPaths[0]).toLowerCase();
    let entered!: () => void;
    let release!: () => void;
    const observed = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    let stopped = false;
    const controller = new AbortController();
    promises.lstat = (async (path: any, options: any) => {
      if (!stopped && win32.normalize(String(path)).toLowerCase() === metadataPath) {
        stopped = true;
        entered();
        await held;
      }
      return original(path, options);
    }) as typeof original;
    syncBuiltinESMExports();
    const first = runtime.executeFile("read", { path: target }, { signal: controller.signal });
    const outcome = first.then(() => ({ ok: true }), (error: Error) => ({ error }));
    try {
      await bounded(observed, "No production metadata boundary appeared");
      controller.abort();
      release();
      const aborted = await outcome;
      assert.ok("error" in aborted);
      assert.match(aborted.error.message, /aborted/i);
    } finally {
      controller.abort();
      release();
      await outcome;
      promises.lstat = original;
      syncBuiltinESMExports();
    }
    const result = await runtime.executeFile("read", { path: target });
    assert.ok(result.content.some((block) => block.type === "text" && block.text.includes("RECOVERY_CANARY")));
    assert.equal(await readFile(target, "utf8"), "RECOVERY_CANARY\n");
  });
});

// Removing an actually-enumerated entry inside MXC must not masquerade as an
// unavailable backend. Both lstat and a queued directory's readdir can race.
for (const kind of ["file", "directory"] as const) {
  test(`real MXC audit tolerates a ${kind} deleted after enumeration`, windows, async () => {
    await withUncheckedRuntime(async (runtime, fixture) => {
      await link(join(fixture.reference, "visible.txt"), join(fixture.reference, "readonly-second.txt"));
      const volatile = join(fixture.workspace, kind === "file" ? "volatile.txt" : "volatile-dir");
      if (kind === "file") await writeFile(volatile, "REMOVED_DURING_AUDIT\n");
      else { await mkdir(volatile); await writeFile(join(volatile, "child.txt"), "REMOVED_DURING_AUDIT\n"); }
      await withAuditChurn(fixture, async () => {
        await runtime.check();
        const result = await runtime.executeFile("read", { path: join(fixture.reference, "visible.txt") });
        assert.ok(result.content.some((block) => block.type === "text" && block.text.includes("READ_ONLY_CANARY")));
      });
      await assert.rejects(promises.stat(volatile), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    });
  });
}

test("ENOENT tolerance in the real MXC audit still rejects a protected RW hard-link alias", windows, async () => {
  await withUncheckedRuntime(async (runtime, fixture) => {
    const protectedFile = join(fixture.reference, "visible.txt");
    await link(protectedFile, join(fixture.workspace, "protected-alias.txt"));
    await writeFile(join(fixture.workspace, "volatile.txt"), "REMOVED_DURING_AUDIT\n");
    const alias = join(fixture.workspace, "protected-alias.txt");
    await withAuditChurn(fixture, async () => {
      await assert.rejects(runtime.check(), /hard link aliases a protected file/i);
      await assert.rejects(runtime.executeFile("write", { path: alias, content: "MUST_NOT_RUN" }), /hard link aliases a protected file/i);
    });
    assert.equal(await readFile(protectedFile, "utf8"), "READ_ONLY_CANARY\n");
  });
});

test("a transient Windows cleanup lock preserves the completed real MXC file result", windows, async () => {
  await withUncheckedRuntime(async (runtime, fixture) => {
    await runtime.check();
    const target = join(fixture.workspace, "cleanup-result.txt");
    await withCleanupLock(runtime, fixture, 120, async () => {
      const outcome = await runtime.executeFile("write", { path: target, content: "COMPLETED_BEFORE_CLEANUP\n" })
        .then((result) => ({ result }), (error: Error) => ({ error }));
      assert.equal(await readFile(target, "utf8"), "COMPLETED_BEFORE_CLEANUP\n");
      assert.ok("result" in outcome, `The file was written but transient cleanup replaced its result: ${"error" in outcome ? outcome.error.message : ""}`);
      assert.ok(outcome.result.content.some((block) => block.type === "text"));
      assert.deepEqual(await readdir(fixture.options.scratchRoot), []);
    });
  });
});

test("a persistent Windows cleanup lock is reported instead of hiding private material", windows, async () => {
  await withUncheckedRuntime(async (runtime, fixture) => {
    await runtime.check();
    const target = join(fixture.workspace, "persistent-cleanup.txt");
    await withCleanupLock(runtime, fixture, undefined, async () => {
      const outcome = await runtime.executeFile("write", { path: target, content: "COMPLETED_WITH_CLEANUP_ERROR\n" })
        .then((result) => ({ result }), (error: NodeJS.ErrnoException) => ({ error }));
      assert.ok("error" in outcome, "A permanent cleanup error must remain visible");
      assert.match(outcome.error.code ?? "", /EPERM|EACCES|EBUSY/);
      assert.match(outcome.error.message, /effects.*replay|replay.*effects/i);
      assert.equal(await readFile(target, "utf8"), "COMPLETED_WITH_CLEANUP_ERROR\n");
      assert.ok((await readdir(fixture.options.scratchRoot)).length > 0, "The failed removal must not claim its private material was reclaimed");
    });
  });
});

test("a denied real MXC read remains the primary error when cleanup is locked", windows, async () => {
  await withUncheckedRuntime(async (runtime, fixture) => {
    await runtime.check();
    const target = join(fixture.outside, "sentinel.txt");
    await withCleanupLock(runtime, fixture, undefined, async () => {
      const outcome = await runtime.executeFile("read", { path: target })
        .then((result) => ({ result }), (error: NodeJS.ErrnoException) => ({ error }));
      assert.ok("error" in outcome);
      assert.match(outcome.error.code ?? "", /EACCES|EPERM/);
      assert.ok(outcome.error.message.includes(target), "Keep the actual denied target, not just the cleanup path");
      assert.match(outcome.error.message, /effects.*replay|replay.*effects/i);
      assert.equal(await readFile(target, "utf8"), "OUTSIDE_CANARY\n");
    });
  });
});
