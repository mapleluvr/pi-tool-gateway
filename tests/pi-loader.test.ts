import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { createMxcFixture, pwsh } from "./helpers/mxc-fixture.ts";
import { killProcessTree } from "../src/operations.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = join(root, "docs", ".temp", "evidence");

test("the real local Pi 1.4 loader, registered tool execution, user bash and dynamic mode switch use MXC", { skip: process.platform !== "win32", timeout: 90_000 }, async () => {
  const fixture = await createMxcFixture();
  try {
    const shellInput = pwsh?.path;
    assert.ok(shellInput);
    const localPackage = getPackageDir();
    const shell = await realpath(shellInput).catch(async () => realpath(await readlink(shellInput)));
    const agentDir = join(fixture.dir, "agent");
    const home = join(fixture.dir, "home");
    const temp = join(fixture.dir, "tmp");
    await Promise.all([agentDir, home, temp, evidence].map((path) => mkdir(path, { recursive: true })));
    const policyPath = join(fixture.dir, "policy-profile.json");
    await writeFile(policyPath, JSON.stringify({ version: 1, filesystem: {
      readonlyPaths: [fixture.reference], deniedPaths: [join(fixture.reference, "denied.txt")],
    } }));
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const env = {
      SYSTEMROOT: systemRoot, WINDIR: systemRoot, HOME: home, USERPROFILE: home,
      LOCALAPPDATA: join(home, "AppData", "Local"), APPDATA: join(home, "AppData", "Roaming"), TEMP: temp, TMP: temp,
      ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files",
      PATH: [dirname(shell), dirname(process.execPath), join(systemRoot, "System32")].join(";"),
      PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", NO_COLOR: "1",
    };
    const input = {
      piPackageRoot: localPackage, extensionRoot: root, workspace: fixture.workspace,
      reference: fixture.reference, outside: fixture.outside, agentDir, policyPath,
    };
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    const child = spawn(process.execPath, [join(root, "tests", "helpers", "pi-loader-smoke.mjs"), JSON.stringify(input)], {
      cwd: fixture.workspace, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (data) => output.push(data)); child.stderr.on("data", (data) => errors.push(data));
    const timeout = setTimeout(() => killProcessTree(child), 85_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timeout);
    const stdout = Buffer.concat(output).toString("utf8");
    const stderr = Buffer.concat(errors).toString("utf8");
    await writeFile(join(evidence, "pi-local-loader-smoke.stdout.json"), stdout);
    await writeFile(join(evidence, "pi-local-loader-smoke.stderr.log"), stderr);
    assert.equal(code, 0, stderr || stdout);
    const facts = JSON.parse(stdout);
    assert.equal(facts.sdkVersion, "1.4.0");
    assert.ok(facts.loaded.some((path: string) => path.includes("pi-tool-gateway")));
    assert.equal(facts.assistantMessages, 0);
    assert.equal(facts.environmentKeys.some((key: string) => /API.?KEY|TOKEN|SECRET|PASSWORD/i.test(key)), false);
    assert.equal(facts.errors.length, 0);
    assert.equal(await readFile(join(fixture.workspace, "loaded.txt"), "utf8"), "after\n中文 beta\n");
    assert.equal(await readFile(join(fixture.outside, "loaded-external.txt"), "utf8"), "LOADED_EXTERNAL_AFTER\n");
  } finally { await fixture.cleanup(); }
});
