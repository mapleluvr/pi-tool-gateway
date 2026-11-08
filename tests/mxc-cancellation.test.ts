import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMxcRuntime } from "../src/mxc/runtime.ts";
import { runBash } from "../src/exec.ts";
import { createTaskRegistry } from "../src/registry.ts";
import { killProcessTree } from "../src/operations.ts";
import { createMxcFixture } from "./helpers/mxc-fixture.ts";
import { inspectProcess, sameProcess } from "./helpers/process-identity.ts";

async function withRuntime(run: (runtime: Awaited<ReturnType<typeof createMxcRuntime>>, fixture: Awaited<ReturnType<typeof createMxcFixture>>) => Promise<void>) {
  const fixture = await createMxcFixture();
  let runtime: Awaited<ReturnType<typeof createMxcRuntime>> | undefined;
  try { runtime = await createMxcRuntime(fixture.options); await runtime.check(); await run(runtime, fixture); }
  finally { await runtime?.dispose(); await fixture.cleanup(); }
}
const evidence = fileURLToPath(new URL("../docs/.temp/evidence/cancellation/", import.meta.url));
const owned = "[Console]::WriteLine('MXC_CANCEL_PID=' + $PID); [Console]::Out.Flush(); while ($true) { Start-Sleep -Milliseconds 100 }";

for (const action of ["foreground abort", "runtime shutdown"] as const) {
  test(`real MXC ${action} terminates its observed PID before acknowledgement`, { skip: process.platform !== "win32", timeout: 25_000 }, async () => {
    await withRuntime(async (runtime, fixture) => {
      const logs = join(fixture.dir, "cancel-logs"); await mkdir(logs); await mkdir(evidence, { recursive: true });
      const env = { SYSTEMROOT: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", HOME: fixture.dir, USERPROFILE: fixture.dir, LOCALAPPDATA: fixture.dir, TEMP: fixture.dir, TMP: fixture.dir };
      const diagnostic: Record<string, any> = { action, chunks: [], startedAt: Date.now() };
      const registry = createTaskRegistry({ dir: logs });
      const unrelated = spawn(runtime.candidate.path, ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"], { env, stdio: "ignore", windowsHide: true });
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
          diagnostic.chunks.push(update.content[0].text);
          const match = output.match(/MXC_CANCEL_PID=(\d+)\r?\n/);
          if (match) {
            if (diagnostic.seenPid === undefined) { diagnostic.seenPid = Number(match[1]); diagnostic.outputAtFirstMatch = output; }
            observe(Number(match[1]));
          }
        },
      });
      // Attach the rejection observer immediately so abort cannot become an unhandled rejection.
      const completion = command.then((result) => ({ result }), (error: Error) => ({ error }));
      try {
        assert.ok(unrelated.pid);
        let timer: NodeJS.Timeout | undefined;
        const pid = await Promise.race([seen, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("No real PID appeared")), 10_000); })]).finally(() => { if (timer) clearTimeout(timer); });
        diagnostic.before = inspectProcess(runtime.candidate.path, pid, env);
        diagnostic.unrelatedBefore = inspectProcess(runtime.candidate.path, unrelated.pid, env);
        assert.ok(diagnostic.before.observed);
        assert.ok(diagnostic.unrelatedBefore.observed);
        diagnostic.cancelRequestedAt = Date.now();
        if (action === "foreground abort") {
          controller.abort();
          const done = await completion;
          assert.ok("error" in done); assert.match(done.error.message, /aborted/i);
        } else {
          registry.dispose(); await runtime.dispose(); await completion;
        }
        diagnostic.acknowledgedAt = Date.now();
        diagnostic.task = registry.list()[0];
        diagnostic.after = inspectProcess(runtime.candidate.path, pid, env);
        diagnostic.unrelatedAfter = inspectProcess(runtime.candidate.path, unrelated.pid, env);
        diagnostic.output = output;
        diagnostic.completeMarkerPid = Number(output.match(/MXC_CANCEL_PID=(\d+)\r?\n/)?.[1]);
        assert.equal(diagnostic.task.status, "killed", "Cancellation budget expiry is not an executor acknowledgement");
        assert.equal(diagnostic.task.executionError, undefined);
        assert.equal(sameProcess(diagnostic.before.observed, diagnostic.after.observed), false, JSON.stringify(diagnostic));
        assert.equal(sameProcess(diagnostic.unrelatedBefore.observed, diagnostic.unrelatedAfter.observed), true, "The original bystander, not just its PID, must survive");
      } finally {
        controller.abort(); registry.dispose(); await runtime.dispose(); await completion;
        killProcessTree(unrelated); await unrelatedClosed;
        diagnostic.output = output;
        // On a real failure, cleanup only the independently observed original
        // process identity, never a reused numeric PID or a partial output marker.
        const expected = diagnostic.before?.observed;
        const completePid = Number(output.match(/MXC_CANCEL_PID=(\d+)\r?\n/)?.[1]);
        if (expected?.startedUtcTicks && expected.id === completePid) {
          diagnostic.final = inspectProcess(runtime.candidate.path, completePid, env);
          if (sameProcess(expected, diagnostic.final.observed)) {
            const cleanup = spawnSync(runtime.candidate.path, ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${completePid} -ErrorAction SilentlyContinue; if ($p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq '${expected.startedUtcTicks}') { Stop-Process -InputObject $p -Force }`], { env, encoding: "utf8", windowsHide: true, timeout: 5000 });
            diagnostic.hostCleanup = { status: cleanup.status, error: cleanup.error?.message, stderr: cleanup.stderr };
          }
        }
        await writeFile(join(evidence, `${basename(fixture.dir)}-${action.replaceAll(" ", "-")}.json`), JSON.stringify(diagnostic, null, 2));
      }
    });
  });
}
