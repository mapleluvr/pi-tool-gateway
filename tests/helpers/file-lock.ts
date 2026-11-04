import type { BackendCandidate } from "../../src/backends.ts";
import { createBackendExecutor } from "../../src/operations.ts";

/** A real, owned Windows FileShare.None handle, not a synthetic errno. */
export function lockFixtureFile(candidate: BackendCandidate, file: string, cwd: string, holdMs?: number) {
  const controller = new AbortController();
  let acquired = false;
  let output = "";
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const literal = file.replace(/'/g, "''");
  const wait = holdMs === undefined
    ? "while ($true) { Start-Sleep -Milliseconds 50 }"
    : `Start-Sleep -Milliseconds ${holdMs}`;
  const command = `$ErrorActionPreference='Stop'; $handle=[IO.File]::Open('${literal}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None); try { [Console]::WriteLine('FIXTURE_LOCK_ACQUIRED'); [Console]::Out.Flush(); ${wait} } finally { $handle.Dispose() }`;
  const completion = createBackendExecutor(candidate).exec(command, cwd, {
    signal: controller.signal,
    env: {
      SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "C:\\Windows",
      HOME: cwd, USERPROFILE: cwd, LOCALAPPDATA: cwd, TEMP: cwd, TMP: cwd,
    },
    onData(data) {
      output += data.toString("utf8");
      if (!acquired && output.includes("FIXTURE_LOCK_ACQUIRED")) { acquired = true; readyResolve(); }
    },
  });
  void completion.then(() => {
    if (!acquired) readyReject(new Error(`Fixture lock was not acquired: ${output}`));
  }, (error: Error) => readyReject(error));
  return { ready, completion, async stop() { controller.abort(); await completion; } };
}
