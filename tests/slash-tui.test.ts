import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createMxcFixture, pwsh } from "./helpers/mxc-fixture.ts";
import { killProcessTree } from "../src/operations.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("real Pi keeps consecutive gateway receipts visible and out of model context across widths/themes", {
  skip: process.platform !== "win32", timeout: 45_000,
}, async () => {
  const fixture = await createMxcFixture();
  try {
    const shellInput = pwsh?.path;
    assert.ok(shellInput);
    const shell = await realpath(shellInput).catch(async () => realpath(await readlink(shellInput)));
    const agentDir = join(fixture.dir, "agent");
    const home = join(fixture.dir, "home");
    const temp = join(fixture.dir, "tmp");
    const workspace = join(fixture.workspace, "工作区 Shared 中文");
    const evidence = join(root, "docs", ".temp", "evidence");
    await Promise.all([agentDir, home, temp, workspace, evidence].map((path) => mkdir(path, { recursive: true })));
    const system = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const env = {
      SYSTEMROOT: system, WINDIR: system, HOME: home, USERPROFILE: home,
      LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"),
      TEMP: temp, TMP: temp, ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files",
      PATH: [dirname(shell), dirname(process.execPath), join(system, "System32")].join(";"),
      PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", NO_COLOR: "1",
    };
    const policyPath = join(fixture.dir, "invalid-profile.json");
    await writeFile(policyPath, "{invalid profile fixture");
    const input = { piPackageRoot: getPackageDir(), extensionRoot: root, workspace, agentDir, policyPath };
    const output: Buffer[] = []; const errors: Buffer[] = [];
    const child = spawn(process.execPath, [join(root, "tests", "helpers", "slash-tui-smoke.mjs"), JSON.stringify(input)], {
      cwd: workspace, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => output.push(data));
    child.stderr.on("data", (data) => errors.push(data));
    const timer = setTimeout(() => killProcessTree(child), 40_000);
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("close", resolve);
      });
    } finally { clearTimeout(timer); }
    const stdout = Buffer.concat(output).toString("utf8");
    const stderr = Buffer.concat(errors).toString("utf8");
    await writeFile(join(evidence, "slash-tui-components.stdout.json"), stdout);
    await writeFile(join(evidence, "slash-tui-components.stderr.log"), stderr);
    assert.equal(code, 0, stderr || stdout);
    const facts = JSON.parse(stdout);
    assert.equal(facts.sdkVersion, "1.4.0");
    assert.equal(facts.receipts, 4);
    assert.equal(facts.modelContextUnchanged, true);
  } finally { await fixture.cleanup(); }
});
