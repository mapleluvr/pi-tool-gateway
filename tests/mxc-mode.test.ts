import test from "node:test";
import assert from "node:assert/strict";
import type { BackendCandidate } from "../src/backends.ts";

// The check is the external/slow OS boundary. These tests prove mode control,
// not MXC capability; separate integration tests exercise the real runner.
const moduleUrl = new URL("../src/mxc/mode.ts", import.meta.url).href;
const implementation: any = await import(moduleUrl).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return undefined;
  throw error;
});
function create(check: (...args: any[]) => Promise<unknown>, options: Record<string, unknown> = {}) {
  assert.ok(implementation, "MXC mode resolution is not implemented");
  return implementation.createMxcModeController({ check, platform: "win32", ...options });
}
const pwsh: BackendCandidate = {
  id: "pwsh7", kind: "powershell", label: "PowerShell 7 (7.6.9)",
  path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
  commandTransport: "argv", version: "7.6.9",
};
const base = { requested: true, candidate: pwsh, workspace: "D:\\fixture", revision: "v1" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("disabled mode stays native without invoking the MXC check", async () => {
  let calls = 0;
  const mode = create(async () => { calls++; return { fixture: "unused" }; });
  mode.configure({ ...base, requested: false });
  assert.equal((await mode.resolve()).mode, "native");
  assert.equal(mode.snapshot().phase, "inactive");
  assert.equal(calls, 0);
});

test("requested MXC is inactive for Git Bash and Windows PowerShell 5.1", async () => {
  let calls = 0;
  const mode = create(async () => { calls++; return {}; });
  for (const candidate of [
    { ...pwsh, id: "gitbash", kind: "bash", path: "C:\\Git\\bin\\bash.exe" },
    { ...pwsh, id: "powershell51", path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", version: "5.1" },
  ]) {
    mode.configure({ ...base, candidate });
    assert.equal((await mode.resolve()).mode, "native");
    assert.equal(mode.snapshot().requested, true);
    assert.equal(mode.snapshot().phase, "inactive");
  }
  assert.equal(calls, 0);
});

test("pwsh-only MXC eligibility also rejects non-Windows hosts", async () => {
  let calls = 0;
  const mode = create(async () => { calls++; return {}; }, { platform: "linux" });
  mode.configure(base);
  assert.equal((await mode.resolve()).mode, "native");
  assert.equal(calls, 0);
});

test("concurrent callers share one availability check and the accepted runtime", async () => {
  const gate = deferred<{ policyId: string }>();
  let calls = 0;
  const mode = create(async () => { calls++; return gate.promise; });
  mode.configure(base);
  const left = mode.resolve();
  const right = mode.resolve();
  assert.equal(mode.snapshot().phase, "checking");
  gate.resolve({ policyId: "controlled-fixture-v1" });
  const [a, b] = await Promise.all([left, right]);
  assert.equal(a.mode, "mxc");
  assert.equal(a.runtime.policyId, "controlled-fixture-v1");
  assert.equal(a.runtime, b.runtime);
  assert.equal(mode.snapshot().phase, "ready");
  assert.equal(calls, 1);
});

test("pre-call unavailability selects native but preserves the user's MXC preference", async () => {
  const mode = create(async () => { throw new Error("trusted runner missing"); });
  mode.configure(base);
  const lease = await mode.resolve();
  assert.equal(lease.mode, "native");
  assert.equal(mode.snapshot().phase, "fallback");
  assert.equal(mode.snapshot().requested, true);
  assert.match(mode.snapshot().reason, /runner missing/);
});

test("a superseded check cannot enable MXC after the user turned it off", async () => {
  const gate = deferred<object>();
  const mode = create(async () => gate.promise);
  mode.configure(base);
  const old = mode.resolve();
  const rejected = assert.rejects(old, /configuration changed/i);
  mode.configure({ ...base, requested: false });
  gate.resolve({ policyId: "stale" });
  await rejected;
  assert.equal((await mode.resolve()).mode, "native");
  assert.equal(mode.snapshot().phase, "inactive");
});

test("cancelling one waiter leaves a sibling availability check usable", async () => {
  const gate = deferred<object>();
  const mode = create(async () => gate.promise);
  mode.configure(base);
  const controller = new AbortController();
  const cancelled = mode.resolve(controller.signal);
  const rejected = assert.rejects(cancelled, /aborted/i);
  const sibling = mode.resolve();
  controller.abort();
  await rejected;
  gate.resolve({ policyId: "sibling" });
  assert.equal((await sibling).mode, "mxc");
  assert.equal(mode.snapshot().phase, "ready");
});

test("rechecking replaces a cached fallback only after a new check succeeds", async () => {
  let available = false;
  const mode = create(async () => {
    if (!available) throw new Error("temporarily unavailable");
    return { policyId: "recovered" };
  });
  mode.configure(base);
  assert.equal((await mode.resolve()).mode, "native");
  available = true;
  assert.equal((await mode.resolve()).mode, "native");
  mode.invalidate();
  const lease = await mode.resolve();
  assert.equal(lease.mode, "mxc");
  assert.equal(lease.runtime.policyId, "recovered");
});

test("a late old-task failure cannot downgrade a newer accepted policy", async () => {
  const mode = create(async (config: any) => ({ policyId: config.revision }));
  mode.configure(base);
  const old = await mode.resolve();
  mode.configure({ ...base, revision: "v2" });
  const current = await mode.resolve();
  mode.unavailable(old.generation, new Error("old runner failed"));
  const after = await mode.resolve();
  assert.equal(after.mode, "mxc");
  assert.equal(after.runtime.policyId, "v2");
  assert.equal(after.generation, current.generation);
});

test("custom pwsh remains eligible after absolute-path Shell selection", async () => {
  const mode = create(async () => ({ policyId: "custom-pwsh" }));
  mode.configure({ ...base, candidate: { ...pwsh, id: "custom" } });
  const lease = await mode.resolve();
  assert.equal(lease.mode, "mxc");
  assert.equal(lease.runtime.policyId, "custom-pwsh");
});

test("a current-runtime failure drops the cached lease before the next call", async () => {
  const mode = create(async () => ({ policyId: "current" }));
  mode.configure(base);
  const lease = await mode.resolve();
  assert.equal(lease.mode, "mxc");
  mode.unavailable(lease.generation, new Error("runner connection lost"));
  const next = await mode.resolve();
  assert.equal(next.mode, "native");
  assert.equal(mode.snapshot().requested, true);
  assert.match(next.reason, /connection lost/);
});

test("a bounded hung check falls back instead of pinning the tool loop indefinitely", async () => {
  const mode = create(async () => new Promise(() => undefined), { checkTimeoutMs: 25 });
  mode.configure(base);
  assert.equal((await mode.resolve()).mode, "native");
  assert.match(mode.snapshot().reason, /timed out/i);
});

test("a validated candidate replaces the current lease without rechecking or mutating the old lease", async () => {
  let calls = 0;
  const mode = create(async () => { calls++; return { policyId: "old" }; });
  mode.configure(base);
  const old = await mode.resolve();
  assert.equal(typeof mode.commit, "function", "Validated policy handoff is not implemented");
  mode.commit({ ...base, revision: "accepted-candidate" }, { policyId: "new" }, mode.snapshot().generation);
  const next = await mode.resolve();
  assert.equal(next.mode, "mxc"); assert.equal(next.runtime.policyId, "new");
  assert.equal(old.runtime.policyId, "old"); assert.equal(calls, 1);
});

test("a stale validated candidate cannot undo a newer off preference", async () => {
  const mode = create(async () => ({ policyId: "old" }));
  mode.configure(base); await mode.resolve();
  const generation = mode.snapshot().generation;
  mode.configure({ ...base, requested: false });
  assert.equal(typeof mode.commit, "function", "Validated policy handoff is not implemented");
  assert.throws(() => mode.commit({ ...base, revision: "late" }, { policyId: "late" }, generation), /changed|stale/i);
  assert.equal((await mode.resolve()).mode, "native"); assert.equal(mode.snapshot().requested, false);
});

test("validated candidate handoff still enforces requested pwsh eligibility", async () => {
  const mode = create(async () => ({ policyId: "current" }));
  mode.configure(base); await mode.resolve();
  assert.equal(typeof mode.commit, "function", "Validated policy handoff is not implemented");
  for (const candidate of [
    { ...base, requested: false },
    { ...base, candidate: { ...pwsh, id: "gitbash", kind: "bash" } },
  ]) {
    assert.throws(() => mode.commit(candidate, { policyId: "ineligible" }, mode.snapshot().generation), /eligible|pwsh|requested/i);
    assert.equal((await mode.resolve()).runtime.policyId, "current");
  }
});
