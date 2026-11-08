import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBackendExecutor } from "../src/operations.ts";
import { pwsh } from "./helpers/mxc-fixture.ts";
import { withGateway } from "./helpers/gateway-fixture.ts";

const windows = { skip: process.platform !== "win32", timeout: 60_000 };
function accepted(notices: { text: string; kind: string }[]) {
  assert.ok(notices.length > 0);
  assert.equal(notices.some((notice) => notice.kind === "error"), false, JSON.stringify(notices));
}

// Review R1: distinguish a contained link attempt after successful startup
// from a trusted host creating an alias behind a cached layout audit.
test("a real MXC command cannot add a protected hard link to a newly granted RW root after startup", windows, async () => {
  await withGateway(async ({ command, call, fixture, extra }) => {
    const source = join(fixture.reference, "visible.txt");
    const alias = join(extra, "after-startup-alias.txt");
    const writable = join(extra, "write-control.txt");
    const script = `$ErrorActionPreference='Stop'; Get-Content -LiteralPath '${source}'; Set-Content -LiteralPath '${writable}' -Value $PID; try { New-Item -ItemType HardLink -Path '${alias}' -Value '${source}' | Out-Null; Write-Output 'LINK_CREATED' } catch { Write-Output ('LINK_DENIED: ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message) }`;
    assert.ok(pwsh);
    assert.equal((await stat(source)).nlink, 1);
    let nativeOutput = "";
    const native = await createBackendExecutor(pwsh).exec(script, fixture.workspace, {
      env: { SYSTEMROOT: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", HOME: fixture.dir, USERPROFILE: fixture.dir, LOCALAPPDATA: fixture.dir, TEMP: fixture.dir, TMP: fixture.dir },
      onData: (data) => { nativeOutput += data.toString("utf8"); },
    });
    assert.equal(native.exitCode, 0, nativeOutput);
    assert.match(nativeOutput, /LINK_CREATED/);
    assert.equal((await stat(source)).nlink, 2);
    await unlink(alias);
    assert.equal((await stat(source)).nlink, 1);
    accepted(await command(`allow rw "${extra}"`));
    const result = await call("bash", { command: script, timeout: 10 });
    assert.equal(result.details.execution.mode, "mxc");
    const output = result.content.map((block: any) => block.type === "text" ? block.text : "").join("\n");
    assert.match(output, /READ_ONLY_CANARY/);
    assert.match(output, /LINK_DENIED/);
    assert.doesNotMatch(output, /LINK_CREATED/);
    await assert.rejects(stat(alias), { code: "ENOENT" });
    assert.equal((await stat(source)).nlink, 1);
    assert.equal(await readFile(source, "utf8"), "READ_ONLY_CANARY\n");
  });
});

// Review R2: mutate the actual trusted profile at the post-commit notification
// boundary, before the next business call. Nothing stubs a policy or file result.
test("a profile changed immediately after grant commit governs the next real file and pwsh invocation", windows, async () => {
  let profile = "";
  await withGateway(async ({ command, call, ctx, extra, notices }) => {
    const target = join(extra, "profile-flip.txt");
    await writeFile(target, "POST_COMMIT_PROFILE_CANARY\n");
    accepted(await command(`allow ro "${extra}"`));
    assert.match((await call("read", { path: target })).structuredContent, /POST_COMMIT_PROFILE_CANARY/);
    const before = await call("bash", { command: "Write-Output 'BEFORE_PROFILE_CHANGE'", timeout: 10 });
    const original = ctx.ui.notify;
    let changes = 0;
    ctx.ui.notify = (text: string, kind: string) => {
      original(text, kind);
      if (/^会话目录 RO:/m.test(text)) {
        writeFileSync(profile, JSON.stringify({ version: 1, filesystem: { deniedPaths: [target] } }));
        changes++;
      }
    };
    try { accepted(await command(`allow ro "${extra}"`)); }
    finally { ctx.ui.notify = original; }
    assert.equal(changes, 1, "The profile must change after commit, not before the candidate's freshness check");
    await assert.rejects(call("read", { path: target }), /EACCES|EPERM|denied/i);
    const after = await call("bash", {
      command: `$ErrorActionPreference='Stop'; try { Get-Content -LiteralPath '${target}'; Write-Output 'STALE_PROFILE_READ' } catch { Write-Output 'CURRENT_PROFILE_DENIED' }`, timeout: 10,
    });
    assert.equal(after.details.execution.mode, "mxc");
    assert.notEqual(after.details.execution.policyId, before.details.execution.policyId);
    assert.match(after.content[0].text, /CURRENT_PROFILE_DENIED/);
    assert.doesNotMatch(after.content[0].text, /POST_COMMIT_PROFILE_CANARY|STALE_PROFILE_READ/);
    assert.equal(notices.some((notice) => /已切回普通 pwsh/.test(notice.text)), false);
    assert.equal(await readFile(target, "utf8"), "POST_COMMIT_PROFILE_CANARY\n");
  }, async (fixture) => {
    profile = join(fixture.dir, "review-profile.json");
    await writeFile(profile, JSON.stringify({ version: 1, filesystem: {} }));
    return { policyPath: profile };
  });
});
