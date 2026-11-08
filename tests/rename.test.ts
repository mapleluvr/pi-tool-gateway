import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../index.ts";
import { createBackendStateStore } from "../src/state.ts";

const legacyState = {
  version: 1,
  backend: "gitbash",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

async function withStateFiles(
  run: (value: { dir: string; statePath: string; legacyStatePath: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-tool-gateway-rename-"));
  try {
    await run({
      dir,
      statePath: join(dir, "pi-tool-gateway.json"),
      legacyStatePath: join(dir, "pi-bash-bg.json"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a missing gateway state keeps the user's legacy Shell selection", async () => {
  await withStateFiles(async ({ statePath, legacyStatePath }) => {
    await writeFile(legacyStatePath, JSON.stringify(legacyState));
    const store = createBackendStateStore({ statePath, legacyStatePath });
    assert.deepEqual(store.read().selection, { backend: "gitbash" });
  });
});

test("saving the migrated selection leaves the active legacy plugin's state intact", async () => {
  await withStateFiles(async ({ statePath, legacyStatePath }) => {
    const original = `${JSON.stringify(legacyState)}\n`;
    await writeFile(legacyStatePath, original);
    const store = createBackendStateStore({ statePath, legacyStatePath });
    assert.equal(store.read().selection.backend, "gitbash");
    store.write({ backend: "pwsh7" });
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).backend, "pwsh7");
    assert.equal(await readFile(legacyStatePath, "utf8"), original);
    assert.equal(store.read().selection.backend, "pwsh7");
  });
});

test("existing gateway state wins over a different legacy selection", async () => {
  await withStateFiles(async ({ statePath, legacyStatePath }) => {
    await writeFile(legacyStatePath, JSON.stringify(legacyState));
    await writeFile(statePath, JSON.stringify({ ...legacyState, backend: "pwsh7" }));
    assert.equal(createBackendStateStore({ statePath, legacyStatePath }).read().selection.backend, "pwsh7");
  });
});

test("corrupt gateway state warns instead of resurrecting legacy preferences", async () => {
  await withStateFiles(async ({ statePath, legacyStatePath }) => {
    await writeFile(legacyStatePath, JSON.stringify(legacyState));
    await writeFile(statePath, "{broken");
    const loaded = createBackendStateStore({ statePath, legacyStatePath }).read();
    assert.equal(loaded.selection.backend, "auto");
    assert.match(loaded.warning!, /invalid.*JSON/i);
  });
});

test("the default store migrates and writes only the new package's state file", async () => {
  await withStateFiles(async ({ dir, statePath, legacyStatePath }) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const original = JSON.stringify(legacyState);
    await writeFile(legacyStatePath, original);
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const store = createBackendStateStore();
      assert.equal(store.statePath, statePath);
      assert.equal(store.read().selection.backend, "gitbash");
      store.write({ backend: "powershell51" });
      assert.equal(JSON.parse(await readFile(statePath, "utf8")).backend, "powershell51");
      assert.equal(await readFile(legacyStatePath, "utf8"), original);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

test("the gateway foreground budget takes precedence over the legacy variable", async () => {
  await withStateFiles(async ({ dir, statePath }) => {
    const previousNew = process.env.PI_TOOL_GATEWAY_THRESHOLD_MS;
    const previousLegacy = process.env.PI_BASH_BG_THRESHOLD_MS;
    const tools = new Map<string, any>();
    const handlers = new Map<string, any>();
    const pi = {
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      registerEntryRenderer() {},
      registerFlag() {},
      getFlag() { return undefined; },
      on(name: string, handler: any) { handlers.set(name, handler); },
    };
    process.env.PI_TOOL_GATEWAY_THRESHOLD_MS = "5";
    process.env.PI_BASH_BG_THRESHOLD_MS = "5000";
    const ctx = { cwd: dir };
    try {
      createExtension(pi as any, {
        stateStore: createBackendStateStore({ statePath }),
        discoverBackends: () => [{
          id: "gitbash", kind: "bash", label: "Node transport fixture", path: process.execPath,
          args: ["-e"], commandTransport: "argv",
        }],
        outputDir: join(dir, "logs"),
      });
      const result = await tools.get("bash").execute(
        "budget", { command: "setTimeout(() => console.log('budget-finished'), 150)" },
        undefined, undefined, ctx,
      );
      assert.match(result.content[0].text, /background task created/);
      const joined = await tools.get("bg_join").execute(
        "join", { taskId: result.details.taskId, timeoutSeconds: 5 }, undefined, undefined, ctx,
      );
      assert.match(joined.content[0].text, /budget-finished/);
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      if (previousNew === undefined) delete process.env.PI_TOOL_GATEWAY_THRESHOLD_MS;
      else process.env.PI_TOOL_GATEWAY_THRESHOLD_MS = previousNew;
      if (previousLegacy === undefined) delete process.env.PI_BASH_BG_THRESHOLD_MS;
      else process.env.PI_BASH_BG_THRESHOLD_MS = previousLegacy;
    }
  });
});
