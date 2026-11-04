import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverBackends } from "../src/backends.ts";

import { createBackendStateStore } from "../src/state.ts";

const realGitBashPath = discoverBackends().find(
  (candidate) => candidate.id === "gitbash",
)?.path;

async function withStateStore(
  fn: (store: ReturnType<typeof createBackendStateStore>, path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-state-"));
  const path = join(dir, "pi-bash-bg.json");
  try {
    await fn(createBackendStateStore({ statePath: path }), path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("missing backend state defaults to auto", async () => {
  await withStateStore(async (store) => {
    const result = store.read();
    assert.equal(result.selection.backend, "auto");
    assert.equal(result.warning, undefined);
  });
});

test("backend selection persists and reloads", async () => {
  await withStateStore(async (store) => {
    store.write({ backend: "gitbash" });
    const result = store.read();
    assert.equal(result.selection.backend, "gitbash");
    assert.equal(result.selection.shellPath, undefined);
  });
});

test(
  "custom backend state persists its absolute shell path",
  { skip: !realGitBashPath },
  async () => {
    await withStateStore(async (store, path) => {
      const shellPath = realGitBashPath!;
      store.write({ backend: "custom", shellPath });
      const result = store.read();
      assert.deepEqual(result.selection, { backend: "custom", shellPath });
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      assert.equal(raw.version, 1);
      assert.equal(raw.shellPath, shellPath);
      assert.equal(typeof raw.updatedAt, "string");
    });
  },
);

test("invalid state falls back to auto with a warning", async () => {
  await withStateStore(async (store, path) => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        backend: "custom",
        shellPath: "C:\\missing\\bash.exe",
      }),
    );
    const result = store.read();
    assert.equal(result.selection.backend, "auto");
    assert.match(result.warning ?? "", /invalid|missing|auto/i);
  });
});

test("existing unknown custom shell files are rejected", async () => {
  await withStateStore(async (store, path) => {
    const toolPath = join(path, "..", "tool.exe");
    await writeFile(toolPath, "not a shell");
    await writeFile(
      path,
      JSON.stringify({ version: 1, backend: "custom", shellPath: toolPath }),
    );
    const result = store.read();
    assert.equal(result.selection.backend, "auto");
    assert.match(result.warning ?? "", /Bash or PowerShell|invalid/i);
  });
});
test("state rejects a copied cmd.exe even when renamed to bash.exe", async () => {
  if (process.platform !== "win32") return;
  await withStateStore(async (store, path) => {
    const shellPath = join(path, "..", "bash.exe");
    await copyFile(join(process.env.WINDIR ?? "C:\\Windows", "System32", "cmd.exe"), shellPath);
    await writeFile(
      path,
      JSON.stringify({ version: 1, backend: "custom", shellPath }),
    );
    const result = store.read();
    assert.equal(result.selection.backend, "auto");
    assert.match(result.warning ?? "", /Bash|probe|cmd/i);
  });
});
test("cmd state is rejected instead of becoming a selectable backend", async () => {
  await withStateStore(async (store, path) => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        backend: "custom",
        shellPath: "C:\\Windows\\System32\\cmd.exe",
      }),
    );
    const result = store.read();
    assert.equal(result.selection.backend, "auto");
    assert.match(result.warning ?? "", /cmd\.exe/i);
  });
});
