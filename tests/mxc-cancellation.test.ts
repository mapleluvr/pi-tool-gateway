import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createMxcRuntime } from "../src/mxc/runtime.ts";
import { runBash } from "../src/exec.ts";
import { createTaskRegistry } from "../src/registry.ts";
import { killProcessTree } from "../src/operations.ts";
import { createMxcFixture } from "./helpers/mxc-fixture.ts";

async function withRuntime(run: (runtime: Awaited<ReturnType<typeof createMxcRuntime>>, fixture: Awaited<ReturnType<typeof createMxcFixture>>) => Promise<void>) {
  const fixture = await createMxcFixture();
  let runtime: Awaited<ReturnType<typeof createMxcRuntime>> | undefined;
  try { runtime = await createMxcRuntime(fixture.options); await runtime.check(); await run(runtime, fixture); }
  finally { await runtime?.dispose(); await fixture.cleanup(); }
}
function observePid(shell: string, pid: number): boolean {
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 3 }`], { stdio: "ignore", windowsHide: true, timeout: 5000 });
  assert.equal(result.error, undefined); assert.ok(result.status === 0 || result.status === 3);
  return result.status === 0;
}
const owned = "[Console]::WriteLine('MXC_CANCEL_PID=' + $PID); [Console]::Out.Flush(); while ($true) { Start-Sleep -Milliseconds 100 }";

for (const action of ["foreground abort", "runtime shutdown"] as const) {
  test(`real MXC ${action} terminates its observed PID before acknowledgement`, { skip: process.platform !== "win32", timeout: 25_000 }, async () => {
    await withRuntime(async (runtime, fixture) => {
      const logs = join(fixture.dir, "cancel-logs"); await mkdir(logs);
      const registry = createTaskRegistry({ dir: logs });
      const unrelated = spawn(runtime.candidate.path, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"], { stdio: "ignore", windowsHide: true });
      const unrelatedClosed = new Promise<void>((resolve) => unrelated.once("close", () => resolve()));
      const controller = new AbortController();
      let observe!: (pid: number) => void;
      const seen = new Promise<number>((resolve) => { observe = resolve; });
      let output = "";
      const command = runBash(registry, owned, {
        cwd: fixture.workspace, thresholdMs: 20_000, executor: runtime.createExecutor(), signal: controller.signal,
        execution: { mode: "mxc", shellPath: runtime.candidate.path, workspace: fixture.workspace, policyId: runtime.policyId },
        onUpdate: (update) => {
          output += update.content[0].text;
          const match = output.match(/MXC_CANCEL_PID=(\d+)/);
          if (match) observe(Number(match[1]));
        },
      });
      // Attach the rejection observer immediately so abort cannot become an unhandled rejection.
      const completion = command.then((result) => ({ result }), (error: Error) => ({ error }));
      try {
        assert.ok(unrelated.pid);
        let timer: NodeJS.Timeout | undefined;
        const pid = await Promise.race([seen, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("No real PID appeared")), 10_000); })]).finally(() => { if (timer) clearTimeout(timer); });
        assert.equal(observePid(runtime.candidate.path, pid), true);
        if (action === "foreground abort") {
          controller.abort();
          const done = await completion;
          assert.ok("error" in done); assert.match(done.error.message, /aborted/i);
        } else {
          registry.dispose(); await runtime.dispose(); await completion;
        }
        assert.equal(observePid(runtime.candidate.path, pid), false);
        assert.equal(observePid(runtime.candidate.path, unrelated.pid), true);
      } finally { controller.abort(); registry.dispose(); await runtime.dispose(); await completion; killProcessTree(unrelated); await unrelatedClosed; }
    });
  });
}
