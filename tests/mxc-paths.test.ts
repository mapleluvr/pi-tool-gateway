import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { createMxcRuntime, type MxcRuntime } from "../src/mxc/runtime.ts";
import { createMxcFixture } from "./helpers/mxc-fixture.ts";

const windows = { skip: process.platform !== "win32", timeout: 45_000 };
async function withRoots(run: (fixture: Awaited<ReturnType<typeof createMxcFixture>>, extra: string, use: (options?: Record<string, unknown>) => Promise<MxcRuntime>) => Promise<void>) {
  const fixture = await createMxcFixture();
  const extra = join(fixture.dir, "Shared Temp 中文");
  const runtimes: MxcRuntime[] = [];
  try {
    await mkdir(extra);
    await run(fixture, extra, async (options = {}) => {
      const candidate = { ...fixture.options, readwritePaths: [extra], ...options };
      const runtime = await createMxcRuntime(candidate);
      runtimes.push(runtime);
      return runtime;
    });
  } finally {
    await Promise.all(runtimes.map((runtime) => runtime.dispose()));
    await fixture.cleanup();
  }
}

// Catches an executor/worker still using only cwd after an external RW grant.
test("an external RW directory is shared by real Pi write/edit/read and pwsh", windows, async () => {
  await withRoots(async (fixture, extra, use) => {
    const runtime = await use();
    await runtime.check();
    const path = join(extra, "shared.txt");
    await runtime.executeFile("write", { path, content: "BEFORE\n" });
    await runtime.executeFile("edit", { path, edits: [{ oldText: "BEFORE", newText: "AFTER" }] });
    const read = await runtime.executeFile("read", { path });
    assert.ok(read.content.some((block) => block.type === "text" && block.text.includes("AFTER")));
    let output = "";
    const result = await runtime.createExecutor().exec(`$ErrorActionPreference='Stop'; Add-Content -LiteralPath '${path}' -Value 'PWSH_SHARED'; Get-Content -LiteralPath '${path}'`, fixture.workspace, { onData: (data) => { output += data.toString("utf8"); } });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /AFTER/); assert.match(output, /PWSH_SHARED/);
    assert.match(await readFile(path, "utf8"), /PWSH_SHARED/);
    await assert.rejects(runtime.executeFile("read", { path: join(fixture.outside, "sentinel.txt") }), /EACCES|EPERM|denied/i);
  });
});

for (const protectedKind of ["readonly", "deny", "control", "profile"] as const) {
  // Catches any overlap check still comparing trusted resources to cwd alone.
  test(`an extra RW root cannot encompass ${protectedKind} resources`, windows, async () => {
    await withRoots(async (fixture, _extra, use) => {
      const options: Record<string, unknown> = {};
      if (protectedKind === "readonly" || protectedKind === "deny") {
        options.readwritePaths = [fixture.reference];
        if (protectedKind === "deny") options.readonlyPaths = [];
      } else if (protectedKind === "control") {
        await mkdir(fixture.options.scratchRoot, { recursive: true });
        options.readwritePaths = [fixture.options.scratchRoot];
      } else {
        const profile = join(fixture.outside, "profile.json");
        await writeFile(profile, JSON.stringify({ version: 1, filesystem: {} }));
        options.profilePath = profile;
        options.readwritePaths = [fixture.outside];
      }
      await assert.rejects(async () => { const runtime = await use(options); await runtime.check(); }, /protected|readonly|denied|profile|control|RW/i);
      assert.equal(await readFile(join(fixture.reference, "visible.txt"), "utf8"), "READ_ONLY_CANARY\n");
    });
  });
}

test("protected file identities are audited in an extra RW root, not just cwd", windows, async () => {
  await withRoots(async (fixture, extra, use) => {
    const source = join(fixture.reference, "visible.txt");
    await link(source, join(extra, "protected-alias.txt"));
    const runtime = await use();
    await assert.rejects(runtime.check(), /hard.link.*protected|shared file object/i);
    assert.equal(await readFile(source, "utf8"), "READ_ONLY_CANARY\n");
  });
});

test("a protected symlink into an extra RW root is rejected", windows, async () => {
  await withRoots(async (fixture, extra, use) => {
    const target = join(extra, "owned.txt");
    await writeFile(target, "OWNED");
    await symlink(target, join(fixture.reference, "protected-link.txt"), "file");
    const runtime = await use();
    await assert.rejects(runtime.check(), /protected.*RW|reference.*RW/i);
    assert.equal(await readFile(target, "utf8"), "OWNED");
  });
});

test("different RW roots can share their own file objects while both are writable", windows, async () => {
  await withRoots(async (fixture, extra, use) => {
    const source = join(extra, "shared-object.txt");
    await writeFile(source, "BOTH_RW");
    await link(source, join(fixture.workspace, "shared-alias.txt"));
    const runtime = await use(); await runtime.check();
    await runtime.executeFile("write", { path: source, content: "BOTH_RW_AFTER" });
    assert.equal(await readFile(join(fixture.workspace, "shared-alias.txt"), "utf8"), "BOTH_RW_AFTER");
  });
});

test("an extra directory on a second real volume supports the production file worker", windows, async () => {
  await withRoots(async (fixture, extra, use) => {
    const second = await mkdtemp(join(tmpdir(), "pi-tool-gateway-paths-"));
    try {
      assert.notEqual((await stat(second, { bigint: true })).dev, (await stat(fixture.workspace, { bigint: true })).dev, "This local gate needs a real second filesystem volume");
      const runtime = await use({ readwritePaths: [extra, second] }); await runtime.check();
      const path = join(second, "cross-volume.txt");
      await runtime.executeFile("write", { path, content: "SECOND_VOLUME_OK" });
      assert.equal(await readFile(path, "utf8"), "SECOND_VOLUME_OK");
      await runtime.dispose();
    } finally { await rm(second, { recursive: true, force: true }); }
  });
});

test("protected file IDs on a second RW volume cannot be filtered out by cwd's volume", windows, async () => {
  await withRoots(async (fixture, extra, use) => {
    const second = await mkdtemp(join(tmpdir(), "pi-tool-gateway-paths-"));
    try {
      assert.notEqual((await stat(second, { bigint: true })).dev, (await stat(fixture.workspace, { bigint: true })).dev);
      const reference = join(second, "reference"); const writable = join(second, "writable");
      await mkdir(reference); await mkdir(writable);
      const source = join(reference, "protected.txt");
      await writeFile(source, "SECOND_VOLUME_PROTECTED"); await link(source, join(writable, "alias.txt"));
      const runtime = await use({ readwritePaths: [extra, writable], readonlyPaths: [fixture.reference, reference] });
      await assert.rejects(runtime.check(), /hard.link.*protected|shared file object/i);
      assert.equal(await readFile(source, "utf8"), "SECOND_VOLUME_PROTECTED");
      await runtime.dispose();
    } finally { await rm(second, { recursive: true, force: true }); }
  });
});

test("a namespaced extra RW path cannot disguise overlap with readonly resources", windows, async () => {
  await withRoots(async (fixture, _extra, use) => {
    await assert.rejects(use({ readwritePaths: [win32.toNamespacedPath(fixture.reference)] }), /protected|readonly|RW/i);
  });
});
