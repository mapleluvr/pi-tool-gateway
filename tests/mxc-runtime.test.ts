import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { createMxcFixture, pwsh, smallPng } from "./helpers/mxc-fixture.ts";

const moduleUrl = new URL("../src/mxc/runtime.ts", import.meta.url).href;
const implementation: any = await import(moduleUrl).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return undefined;
  throw error;
});
async function withRuntime(run: (runtime: any, fixture: Awaited<ReturnType<typeof createMxcFixture>>) => Promise<void>) {
  const fixture = await createMxcFixture();
  let runtime: any;
  try {
    assert.ok(pwsh, "The local Windows acceptance gate requires a real PowerShell 7 install");
    assert.ok(implementation, "The real MXC transport is not implemented");
    runtime = await implementation.createMxcRuntime(fixture.options);
    await runtime.check();
    await run(runtime, fixture);
  } finally {
    await runtime?.dispose();
    await fixture.cleanup();
  }
}
const local = { skip: process.platform !== "win32" };

test("real MXC pwsh streams stdout before its command has finished", local, async () => {
  await withRuntime(async (runtime, fixture) => {
    let finished = false;
    let earlyBeforeClose = false;
    let output = "";
    const result = await runtime.createExecutor().exec(
      "[Console]::WriteLine('EARLY_中文'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 900; Write-Output 'LATE'",
      fixture.workspace,
      { onData: (data: Buffer) => {
        output += data.toString("utf8");
        if (output.includes("EARLY_中文") && !output.includes("LATE") && !finished) earlyBeforeClose = true;
      } },
    );
    finished = true;
    assert.equal(result.exitCode, 0);
    assert.match(output, /EARLY_中文/);
    assert.match(output, /LATE/);
    assert.equal(earlyBeforeClose, true);
  });
});

test("real MXC pwsh preserves explicit nonzero exit codes", local, async () => {
  await withRuntime(async (runtime, fixture) => {
    const result = await runtime.createExecutor().exec("Write-Output 'nonzero'; exit 7", fixture.workspace, { onData() {} });
    assert.equal(result.exitCode, 7);
  });
});

test("real complete Pi file tools write, edit and read UTF-8 with their structured result", local, async () => {
  await withRuntime(async (runtime, fixture) => {
    const target = join(fixture.workspace, "子目录 空格", "sample.txt");
    await runtime.executeFile("write", { path: target, content: "alpha\n中文 beta\ngamma\n" });
    await runtime.executeFile("edit", { path: target, edits: [{ oldText: "beta", newText: "BETA" }] });
    const read = await runtime.executeFile("read", { path: target, offset: 2, limit: 1 });
    assert.match(read.content[0].text, /中文 BETA/);
    assert.equal(typeof read.structuredContent, "string");
    assert.match(read.structuredContent, /中文 BETA/);
    assert.equal(await readFile(target, "utf8"), "alpha\n中文 BETA\ngamma\n");
    await runtime.executeFile("write", { path: target, content: "replacement\n" });
    assert.equal(await readFile(target, "utf8"), "replacement\n");
  });
});

test("real MXC read and write denials leave host sentinels unchanged", local, async () => {
  await withRuntime(async (runtime, fixture) => {
    const denied = join(fixture.reference, "denied.txt");
    const outside = join(fixture.outside, "sentinel.txt");
    const readonly = join(fixture.reference, "visible.txt");
    await assert.rejects(runtime.executeFile("read", { path: denied }), /EACCES|EPERM|denied|permission/i);
    await assert.rejects(runtime.executeFile("read", { path: outside }), /EACCES|EPERM|denied|permission/i);
    await assert.rejects(runtime.executeFile("write", { path: readonly, content: "ESCAPED" }), /EACCES|EPERM|denied|permission/i);
    await assert.rejects(runtime.executeFile("write", { path: outside, content: "ESCAPED" }), /EACCES|EPERM|denied|permission/i);
    assert.equal(await readFile(denied, "utf8"), "DENIED_CANARY\n");
    assert.equal(await readFile(outside, "utf8"), "OUTSIDE_CANARY\n");
    assert.equal(await readFile(readonly, "utf8"), "READ_ONLY_CANARY\n");
    const allowed = await runtime.executeFile("read", { path: readonly });
    assert.match(allowed.content[0].text, /READ_ONLY_CANARY/);
  });
});

test("real MXC file transport exceeds Windows argv size without exposing host realpath", local, async () => {
  await withRuntime(async (runtime, fixture) => {
    const target = join(fixture.workspace, "large.txt");
    const content = "LARGE_中文".repeat(12_000);
    const original = promises.realpath;
    let hostTargetCalls = 0;
    promises.realpath = (async (path: any, options: any) => {
      if (String(path) === target) {
        hostTargetCalls++;
        throw new Error("Host target realpath must not participate in MXC file execution");
      }
      return original(path, options);
    }) as typeof original;
    syncBuiltinESMExports();
    try {
      await runtime.executeFile("write", { path: target, content });
      await runtime.executeFile("edit", { path: target, edits: [{ oldText: content, newText: "short\n" }] });
      assert.equal(hostTargetCalls, 0);
      assert.equal(await readFile(target, "utf8"), "short\n");
    } finally {
      promises.realpath = original;
      syncBuiltinESMExports();
    }
  });
});

test("real MXC image read preserves image blocks and codemode structured data", local, async () => {
  await withRuntime(async (runtime, fixture) => {
    const target = join(fixture.workspace, "pixel.png");
    await writeFile(target, smallPng());
    const result = await runtime.executeFile("read", { path: target }, { model: { input: ["text", "image"], id: "fixture", name: "Fixture" } });
    const image = result.content.find((block: any) => block.type === "image");
    assert.ok(image, "Expected the real Pi image decoder, not a success note");
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual([...Buffer.from(image.data, "base64").subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(result.structuredContent.type, "image");
    assert.equal(result.structuredContent.data, image.data);
  });
});

test("real MXC processes do not inherit an unrelated host environment canary", local, async () => {
  const prior = process.env.MXC_GATEWAY_HOST_SECRET_CANARY;
  process.env.MXC_GATEWAY_HOST_SECRET_CANARY = "SYNTHETIC_DO_NOT_INHERIT";
  try {
    await withRuntime(async (runtime, fixture) => {
      let output = "";
      const result = await runtime.createExecutor().exec(
        "if ($env:MXC_GATEWAY_HOST_SECRET_CANARY) { Write-Output $env:MXC_GATEWAY_HOST_SECRET_CANARY; exit 8 }; Write-Output 'PRIVATE_ENV_OK'",
        fixture.workspace, { onData: (data: Buffer) => { output += data.toString("utf8"); } },
      );
      assert.equal(result.exitCode, 0);
      assert.match(output, /PRIVATE_ENV_OK/);
      assert.doesNotMatch(output, /SYNTHETIC_DO_NOT_INHERIT/);
    });
  } finally {
    if (prior === undefined) delete process.env.MXC_GATEWAY_HOST_SECRET_CANARY;
    else process.env.MXC_GATEWAY_HOST_SECRET_CANARY = prior;
  }
});
