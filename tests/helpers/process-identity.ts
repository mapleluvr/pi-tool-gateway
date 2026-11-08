import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export interface ProcessIdentity { id: number; name: string; startedUtcTicks: string }
export interface ProcessObservation { probePid: number; observed: ProcessIdentity | null }

function assertIdentity(value: ProcessIdentity): void {
  assert.ok(Number.isSafeInteger(value?.id) && value.id > 0, "Process identity requires a positive PID");
  assert.ok(typeof value.startedUtcTicks === "string" && /^\d+$/.test(value.startedUtcTicks), "Missing process creation time is not proof of exit");
}

/** A numeric PID may already belong to another process when the host probes it. */
export function sameProcess(expected: ProcessIdentity, observed: ProcessIdentity | null): boolean {
  assertIdentity(expected);
  if (observed === null) return false;
  assertIdentity(observed);
  return expected.id === observed.id && expected.startedUtcTicks === observed.startedUtcTicks;
}

/** Host-side observation of one owned fixture PID; never enumerates the host. */
export function inspectProcess(shell: string, pid: number, env: NodeJS.ProcessEnv): ProcessObservation {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const command = `$ErrorActionPreference='Stop'; $lookupErrors=@(); $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue -ErrorVariable lookupErrors; foreach($failure in $lookupErrors) { if($failure.FullyQualifiedErrorId.Split(',')[0] -ne 'NoProcessFoundForGivenId') { throw $failure } }; $found=$null; if($p) { $found=@{id=$p.Id;startedUtcTicks=$p.StartTime.ToUniversalTime().Ticks.ToString();name=$p.ProcessName} }; @{probePid=$PID;observed=$found} | ConvertTo-Json -Compress -Depth 3`;
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    env, encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || "Host process observation failed");
  const observation: ProcessObservation = JSON.parse(result.stdout);
  assert.ok(Number.isSafeInteger(observation.probePid));
  assert.ok(observation.observed === null || typeof observation.observed === "object");
  if (observation.observed !== null) assertIdentity(observation.observed);
  return observation;
}
