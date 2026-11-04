import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import { createBackendExecutor } from "../src/operations.ts";
import { fileURLToPath } from "node:url";
import { createMxcRuntime, type MxcRuntime } from "../src/mxc/runtime.ts";
import { createMxcFixture, pwsh } from "./helpers/mxc-fixture.ts";

const windows = { skip: process.platform !== "win32" };
async function fixtureTest(run: (fixture: Awaited<ReturnType<typeof createMxcFixture>>, use: (options?: Record<string, unknown>) => Promise<MxcRuntime>) => Promise<void>) {
  const fixture = await createMxcFixture();
  let runtime: MxcRuntime | undefined;
  try { await run(fixture, async (options = {}) => { runtime = await createMxcRuntime({ ...fixture.options, ...options }); return runtime; }); }
  finally { await runtime?.dispose(); await fixture.cleanup(); }
}

for (const entry of ["check", "write"] as const) {
  test(`a preexisting RO/RW hard-link collision is blocked before ${entry}`, windows, async () => {
    await fixtureTest(async (fixture, use) => {
      const source = join(fixture.reference, "visible.txt");
      const alias = join(fixture.workspace, "reference-hardlink.txt");
      await link(source, alias);
      const original = await stat(source, { bigint: true });
      const linked = await stat(alias, { bigint: true });
      assert.equal(original.nlink, 2n); assert.equal(original.dev, linked.dev); assert.equal(original.ino, linked.ino);
      const runtime = await use();
      const call = entry === "check" ? runtime.check() : runtime.executeFile("write", { path: alias, content: "HARDLINK_ESCAPED" });
      await assert.rejects(call, /hard.link.*protected|shared file object/i);
      assert.equal(await readFile(source, "utf8"), "READ_ONLY_CANARY\n");
    });
  });
}

test("a contained workload cannot create a writable hard-link alias of a readonly reference", windows, async () => {
  await fixtureTest(async (fixture, use) => {
    const source = join(fixture.reference, "visible.txt");
    const alias = join(fixture.workspace, "new-reference-hardlink.txt");
    assert.ok(pwsh);
    let nativeOutput = "";
    const native = await createBackendExecutor(pwsh).exec(
      `$ErrorActionPreference='Stop'; New-Item -ItemType HardLink -Path '${alias}' -Value '${source}' | Out-Null; Remove-Item -LiteralPath '${alias}'; Write-Output 'NATIVE_HARDLINK_OK'`,
      fixture.workspace, { env: { SYSTEMROOT: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", HOME: fixture.dir, USERPROFILE: fixture.dir, LOCALAPPDATA: fixture.dir, TEMP: fixture.dir, TMP: fixture.dir }, onData: (data) => { nativeOutput += data.toString("utf8"); } },
    );
    assert.equal(native.exitCode, 0, nativeOutput); assert.match(nativeOutput, /NATIVE_HARDLINK_OK/);
    assert.equal((await stat(source)).nlink, 1);
    const runtime = await use(); await runtime.check();
    let output = "";
    const command = `$ErrorActionPreference='Stop'; try { New-Item -ItemType HardLink -Path '${alias}' -Value '${source}' | Out-Null; Write-Output 'LINK_CREATED' } catch { Write-Output 'LINK_DENIED' }`;
    const result = await runtime.createExecutor().exec(command, fixture.workspace, { onData: (data) => { output += data.toString("utf8"); } });
    assert.equal(result.exitCode, 0, output); assert.match(output, /LINK_DENIED/); assert.doesNotMatch(output, /LINK_CREATED/);
    await assert.rejects(stat(alias), { code: "ENOENT" });
    assert.equal(await readFile(source, "utf8"), "READ_ONLY_CANARY\n");
  });
});

test("hard links outside the RW workspace do not disable a readonly reference", windows, async () => {
  await fixtureTest(async (fixture, use) => {
    await link(join(fixture.reference, "visible.txt"), join(fixture.outside, "non-writable-alias.txt"));
    const runtime = await use(); await runtime.check();
    const result = await runtime.executeFile("read", { path: join(fixture.reference, "visible.txt") });
    assert.match(result.content[0].type === "text" ? result.content[0].text : "", /READ_ONLY_CANARY/);
  });
});

test("ordinary RW-to-RW hard links retain their filesystem behavior", windows, async () => {
  await fixtureTest(async (fixture, use) => {
    const source = join(fixture.workspace, "owned.txt");
    const alias = join(fixture.workspace, "owned-alias.txt");
    await writeFile(source, "OWNED_BEFORE"); await link(source, alias);
    const runtime = await use(); await runtime.check();
    await runtime.executeFile("write", { path: alias, content: "OWNED_AFTER" });
    assert.equal(await readFile(source, "utf8"), "OWNED_AFTER");
  });
});

for (const targetExists of [true, false]) {
  test(`a protected reference symlink into RW is rejected (${targetExists ? "existing" : "dangling"})`, windows, async () => {
    await fixtureTest(async (fixture, use) => {
      const target = join(fixture.workspace, "owned-symlink-target.txt");
      if (targetExists) await writeFile(target, "OWNED_BEFORE");
      await symlink(target, join(fixture.reference, "protected-link.txt"), "file");
      const runtime = await use();
      await assert.rejects(runtime.check(), /protected.*RW|reference.*RW/i);
      if (targetExists) assert.equal(await readFile(target, "utf8"), "OWNED_BEFORE");
      else await assert.rejects(stat(target), { code: "ENOENT" });
    });
  });
}

test("a trusted runtime directory cannot contain the RW workspace", windows, async () => {
  await fixtureTest(async (_fixture, use) => {
    const source = fileURLToPath(new URL("../src/mxc/", import.meta.url));
    await assert.rejects(use({ workspace: source }), /trusted.*RW|runtime.*overlap/i);
  });
});

test("a readonly reference tree cannot contain the RW workspace", windows, async () => {
  await fixtureTest(async (fixture, use) => {
    await assert.rejects(use({ readonlyPaths: [fixture.dir] }), /reference.*RW|readonly.*overlap/i);
  });
});

test("a namespaced readonly path cannot hide overlap with the RW workspace", windows, async () => {
  await fixtureTest(async (fixture, use) => {
    await assert.rejects(use({ readonlyPaths: [win32.toNamespacedPath(fixture.workspace)] }), /reference.*RW|readonly.*overlap|trusted.*RW/i);
  });
});

test("private control RW storage cannot be allocated inside a readonly reference", windows, async () => {
  await fixtureTest(async (fixture, use) => {
    await assert.rejects(use({ scratchRoot: join(fixture.reference, "control") }), /control.*readonly|material.*reference|protected.*control/i);
    assert.equal(await readFile(join(fixture.reference, "visible.txt"), "utf8"), "READ_ONLY_CANARY\n");
  });
});

test("a protected reference symlink cannot encompass private RW control storage", windows, async () => {
  await fixtureTest(async (fixture, use) => {
    const storage = fixture.options.scratchRoot!;
    await mkdir(storage, { recursive: true });
    await symlink(storage, join(fixture.reference, "control-link"), "junction");
    const runtime = await use();
    await assert.rejects(runtime.check(), /protected.*control|material.*reference|control.*readonly/i);
  });
});

test("protected code cannot be made writable through a workspace hard-link alias", windows, async () => {
  await fixtureTest(async (fixture, use) => {
    const source = fileURLToPath(new URL("../index.ts", import.meta.url));
    const before = await readFile(source);
    await link(source, join(fixture.workspace, "host-extension-alias.ts"));
    const runtime = await use();
    await assert.rejects(runtime.check(), /hard.link.*protected|shared file object/i);
    assert.deepEqual(await readFile(source), before);
  });
});
