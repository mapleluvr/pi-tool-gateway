import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../index.ts";
import type { BackendCandidate } from "../src/backends.ts";
import { createBackendStateStore } from "../src/state.ts";

function fakePi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const registrations: string[] = [];
  return {
    tools,
    commands,
    handlers,
    registrations,
    registerTool(tool: any) {
      registrations.push(tool.name);
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    registerEntryRenderer() {},
    registerFlag() {},
    getFlag() { return undefined; },
    on(event: string, handler: any) {
      handlers.set(event, handler);
    },
  };
}

function candidate(
  id: "pwsh7" | "gitbash" | "powershell51",
  kind: "bash" | "powershell",
): BackendCandidate {
  const labels = {
    pwsh7: "PowerShell 7",
    gitbash: "Git Bash",
    powershell51: "PowerShell 5.1",
  } as const;
  return {
    id,
    kind,
    label: labels[id],
    path: process.execPath,
    args: ["-e"],
    commandTransport: "argv",
    version: "test",
  };
}

async function withExtension(
  fn: (args: {
    pi: ReturnType<typeof fakePi>;
    state: ReturnType<typeof createBackendStateStore>;
    dir: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-extension-"));
  try {
    const pi = fakePi();
    const state = createBackendStateStore({
      statePath: join(dir, "pi-bash-bg.json"),
    });
    createExtension(pi as any, {
      stateStore: state,
      discoverBackends: () => [
        candidate("pwsh7", "powershell"),
        candidate("gitbash", "bash"),
        candidate("powershell51", "powershell"),
      ],
      outputDir: dir,
    });
    await fn({ pi, state, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("registers bash-select without adding a powershell tool", async () => {
  await withExtension(async ({ pi }) => {
    assert.ok(pi.commands.has("bash-select"));
    for (const name of [
      "bash",
      "bg_run",
      "bg_status",
      "bg_logs",
      "bg_kill",
      "bg_join",
    ]) {
      assert.ok(pi.tools.has(name), `missing tool: ${name}`);
    }
    const completion = await pi.commands
      .get("bash-select")
      .getArgumentCompletions("");
    const values = completion.map((item: any) => item.value ?? item.label);
    assert.deepEqual(values.slice(0, 4), ["auto", "pwsh7", "gitbash", "powershell51"]);
    assert.ok(values.includes(process.execPath));
    assert.doesNotMatch(JSON.stringify(completion), /cmd\.exe/i);
  });
});

test("bash execution includes a persisted fallback warning without UI context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-warning-"));
  try {
    const pi = fakePi();
    const stateStore = {
      read: () => ({
        selection: { backend: "auto" as const },
        warning: "invalid backend state; using auto backend",
      }),
      statePath: "test-state.json",
      write: () => undefined,
    };
    createExtension(pi as any, {
      stateStore,
      discoverBackends: () => [candidate("gitbash", "bash")],
      outputDir: dir,
    });
    const result = await pi.tools.get("bash").execute(
      "warning-test",
      { command: "process.stdout.write('ok')" },
      undefined,
      undefined,
      { cwd: dir },
    );
    assert.match(result.content[0].text, /invalid backend state/);
    assert.match(result.content[0].text, /ok/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("bash forwards executor output through the SDK onUpdate callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bash-bg-streaming-"));
  try {
    const pi = fakePi();
    createExtension(pi as any, {
      stateStore: createBackendStateStore({
        statePath: join(dir, "pi-bash-bg.json"),
      }),
      discoverBackends: () => [candidate("gitbash", "bash")],
      outputDir: dir,
    });
    const updates: any[] = [];
    const result = await pi.tools.get("bash").execute(
      "streaming-test",
      { command: "process.stdout.write('streamed')" },
      undefined,
      (update: any) => updates.push(update),
      { cwd: dir },
    );
    assert.match(result.content[0].text, /streamed/);
    assert.ok(
      updates.some((update) =>
        update.content?.some((part: any) => /streamed/.test(part.text)),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("selecting a backend persists it and refreshes bash metadata immediately", async () => {
  await withExtension(async ({ pi, state }) => {
    const notifications: string[] = [];
    const ctx: any = {
      ui: { notify: (message: string) => notifications.push(message) },
    };
    await pi.commands.get("bash-select").handler("pwsh7", ctx);
    assert.equal(state.read().selection.backend, "pwsh7");
    assert.match(pi.tools.get("bash").description, /PowerShell 7/i);
    assert.ok(notifications.some((message) => /pwsh7|PowerShell/i.test(message)));
    assert.ok(pi.registrations.filter((name) => name === "bash").length >= 2);
  });
});

test("selecting cmd.exe is rejected and leaves the prior state unchanged", async () => {
  await withExtension(async ({ pi, state }) => {
    const notifications: string[] = [];
    const ctx: any = {
      ui: { notify: (message: string) => notifications.push(message) },
    };
    await pi.commands.get("bash-select").handler("gitbash", ctx);
    const before = state.read().selection;
    await pi.commands
      .get("bash-select")
      .handler("C:\\Windows\\System32\\cmd.exe", ctx);
    assert.deepEqual(state.read().selection, before);
    assert.ok(notifications.some((message) => /cmd\.exe/i.test(message)));
  });
});

test("interactive selection applies the selected option without reload", async () => {
  await withExtension(async ({ pi, state }) => {
    let options: string[] = [];
    const ctx: any = {
      ui: {
        select: async (_title: string, values: string[]) => {
          options = values;
          return values.find((value) => /gitbash/i.test(value));
        },
        notify: () => undefined,
      },
    };
    await pi.commands.get("bash-select").handler("", ctx);
    assert.ok(options.some((value) => /auto/i.test(value)));
    assert.equal(state.read().selection.backend, "gitbash");
    assert.match(pi.tools.get("bash").description, /Git Bash/i);
  });
});
