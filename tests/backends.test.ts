import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, copyFile, symlink } from "node:fs/promises";
import { lstatSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCustomCandidate,
  discoverBackends,
  resolveBackend,
  type BackendCandidate,
} from "../src/backends.ts";

function candidate(
  id: BackendCandidate["id"],
  kind: BackendCandidate["kind"],
  path = process.execPath,
): BackendCandidate {
  return {
    id,
    kind,
    label: id,
    path,
    args: kind === "bash" ? ["-c"] : ["-Command"],
    commandTransport: "argv",
    version: "test",
  };
}

test("system backend discovery returns supported candidates without cmd", () => {
  const candidates = discoverBackends();
  assert.doesNotMatch(JSON.stringify(candidates), /cmd\.exe/i);
  for (const candidate of candidates) {
    assert.ok(["pwsh7", "gitbash", "powershell51", "custom"].includes(candidate.id));
  }
});

function storePwshAliasPaths(): string[] {
  if (process.platform !== "win32") return [];
  const result = spawnSync("where.exe", ["pwsh.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) return [];
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((shellPath) => {
      try {
        statSync(shellPath);
        return false;
      } catch {
        try {
          return lstatSync(shellPath).isSymbolicLink();
        } catch {
          return false;
        }
      }
    });
}

test(
  "a Store App Execution Alias for pwsh.exe is discovered as PowerShell 7",
  { skip: storePwshAliasPaths().length === 0 },
  () => {
    const aliasPaths = storePwshAliasPaths();
    const candidates = discoverBackends({
      findOnPath: (executable) => (executable === "pwsh.exe" ? aliasPaths : []),
      programFiles: "",
      programFilesX86: "",
    });
    // Both WindowsApps aliases resolve to the same package target.
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, "pwsh7");
    assert.match(candidates[0].version ?? "", /^7\./);
  },
);

test("a dangling pwsh.exe alias is not accepted as a backend", async () => {
  if (process.platform !== "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-alias-"));
  const aliasPath = join(dir, "pwsh.exe");
  try {
    try {
      await symlink(join(dir, "missing-pwsh.exe"), aliasPath);
    } catch {
      return;
    }
    const candidates = discoverBackends({
      findOnPath: (executable) =>
        executable === "pwsh.exe" ? [aliasPath] : [],
      probeVersion: () => "7.6.7",
      programFiles: "",
      programFilesX86: "",
    });
    assert.deepEqual(candidates, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("auto chooses PowerShell 7 before Git Bash and PowerShell 5.1", () => {
  const selected = resolveBackend("auto", [
    candidate("powershell51", "powershell"),
    candidate("gitbash", "bash"),
    candidate("pwsh7", "powershell"),
  ]);
  assert.equal(selected.id, "pwsh7");
});

test("auto falls back to Git Bash before PowerShell 5.1", () => {
  const selected = resolveBackend("auto", [
    candidate("powershell51", "powershell"),
    candidate("gitbash", "bash"),
  ]);
  assert.equal(selected.id, "gitbash");
});

test("auto chooses PowerShell 5.1 when it is the only supported backend", () => {
  const selected = resolveBackend("auto", [candidate("powershell51", "powershell")]);
  assert.equal(selected.id, "powershell51");
});

test("resolver rejects an injected relative executable candidate", () => {
  assert.throws(
    () => resolveBackend("gitbash", [candidate("gitbash", "bash", "bash.exe")]),
    /absolute|invalid|available/i,
  );
});
test("resolver rejects an injected missing absolute executable candidate", () => {
  assert.throws(
    () => resolveBackend("gitbash", [candidate("gitbash", "bash", "C:\\missing\\bash.exe")]),
    /absolute|missing|available|executable/i,
  );
});
test("auto fails with searched backend details instead of falling back to cmd", () => {
  assert.throws(
    () => resolveBackend("auto", []),
    /No shell backend available.*PowerShell 7.*Git Bash.*PowerShell 5\.1/i,
  );
});

test("explicit backend selection does not use a different discovered backend", () => {
  const selected = resolveBackend("gitbash", [
    candidate("pwsh7", "powershell"),
    candidate("gitbash", "bash"),
  ]);
  assert.equal(selected.id, "gitbash");
});

test("unprobeable pwsh.exe is skipped so auto can use the next backend", async () => {
  const candidates = discoverBackends({
    findOnPath: (executable) => (executable === "pwsh.exe" ? [process.execPath] : []),
    probeVersion: () => undefined,
    programFiles: "",
    programFilesX86: "",
  });
  assert.deepEqual(candidates, []);
});

test("discovery ignores unprobeable Bash and Windows PowerShell candidates", () => {
  const candidates = discoverBackends({
    findOnPath: (executable) =>
      executable === "bash.exe" || executable === "powershell.exe"
        ? [process.execPath]
        : [],
    probeVersion: () => undefined,
    programFiles: "",
    programFilesX86: "",
  });
  assert.deepEqual(candidates, []);
});
test("a copied cmd.exe is rejected even when renamed to bash.exe", async () => {
  if (process.platform !== "win32") return;
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-cmd-copy-"));
  const renamedPath = join(dir, "bash.exe");
  try {
    await copyFile(join(process.env.WINDIR ?? "C:\\Windows", "System32", "cmd.exe"), renamedPath);
    assert.throws(
      () => createCustomCandidate(renamedPath),
      /cmd\.exe|not.*Bash|probe/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("discovery ignores stale configured Git Bash paths", () => {
  const candidates = discoverBackends({
    findOnPath: () => [],
    probeVersion: () => undefined,
    programFiles: "C:\\missing-program-files",
    programFilesX86: "C:\\missing-program-files-x86",
  });
  assert.equal(candidates.some((candidate) => candidate.id === "gitbash"), false);
});
test("custom cmd.exe paths are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-backend-"));
  const cmdPath = join(dir, "cmd.exe");
  try {
    await writeFile(cmdPath, "not an executable");
    assert.throws(() => createCustomCandidate(cmdPath), /cmd\.exe.*not.*allowed/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "custom bash paths are classified as Bash after a real probe",
  { skip: !discoverBackends().some((candidate) => candidate.id === "gitbash") },
  () => {
    const bashPath = discoverBackends().find((candidate) => candidate.id === "gitbash")!.path;
    const custom = createCustomCandidate(bashPath);
    assert.equal(custom.id, "custom");
    assert.equal(custom.kind, "bash");
    assert.equal(custom.path, bashPath);
  },
);

test(
  "custom pwsh paths identify as PowerShell 7 after a real probe",
  { skip: !discoverBackends().some((candidate) => candidate.id === "pwsh7") },
  () => {
    const pwshPath = discoverBackends().find((candidate) => candidate.id === "pwsh7")!.path;
    const custom = createCustomCandidate(pwshPath);
    assert.equal(custom.id, "custom");
    assert.equal(custom.kind, "powershell");
    assert.match(custom.label, /PowerShell 7/i);
  },
);
test("custom unknown executable paths are rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-backend-"));
  const toolPath = join(dir, "tool.exe");
  try {
    await writeFile(toolPath, "test executable placeholder");
    assert.throws(() => createCustomCandidate(toolPath), /Bash or PowerShell/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
