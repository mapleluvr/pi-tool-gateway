import { join } from "node:path";
import { createExtension, type ExtensionDependencies } from "../../index.ts";
import { createBackendStateStore } from "../../src/state.ts";
import { backends, createMxcFixture, pwsh } from "./mxc-fixture.ts";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Only the registration/UI boundary and external MXC runner are doubles.
 * Shell state, extension command handlers and gateway/mode code are production. */
export async function withSlash(
  run: (h: {
    fixture: Awaited<ReturnType<typeof createMxcFixture>>;
    pi: any; ctx: any; state: ReturnType<typeof createBackendStateStore>;
    notices: { text: string; kind: string }[];
    statuses: string[]; widgets: Map<string, string[]>;
    widgetHistory: { key: string; lines: string[] | undefined }[];
    command: (args: string) => Promise<{ text: string; kind: string }[]>;
    restart: () => Promise<void>;
    call: (name: string, args: Record<string, unknown>) => Promise<any>;
  }) => Promise<void>,
  configure?: (fixture: Awaited<ReturnType<typeof createMxcFixture>>, state: ReturnType<typeof createBackendStateStore>) => ExtensionDependencies,
) {
  const fixture = await createMxcFixture();
  const state = createBackendStateStore({ statePath: join(fixture.dir, "shell.json") });
  const tools = new Map<string, any>(); const commands = new Map<string, any>();
  const handlers = new Map<string, any>(); const flags = new Map<string, unknown>();
  const notices: { text: string; kind: string }[] = []; const statuses: string[] = [];
  const widgets = new Map<string, string[]>();
  const widgetHistory: { key: string; lines: string[] | undefined }[] = [];
  const pi: any = {
    tools, commands, handlers,
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerEntryRenderer() {},
    appendEntry(_type: string, data: { text: string; kind: string }) { notices.push({ ...data }); },
    registerFlag: (name: string, flag: any) => flags.set(name, flag.default),
    getFlag: (name: string) => flags.get(name), getSettings: () => ({}),
    getAllTools: () => [...tools.values()], getActiveTools: () => [...tools.keys()],
    on: (name: string, handler: any) => handlers.set(name, handler),
  };
  const ctx: any = { cwd: fixture.workspace, mode: "tui", hasUI: true, ui: {
    notify: (text: string, kind: string) => notices.push({ text, kind }),
    setStatus: (_key: string, text: string) => statuses.push(text),
    setWidget: (key: string, lines: string[] | undefined) => {
      widgetHistory.push({ key, lines: lines ? [...lines] : undefined });
      if (lines) widgets.set(key, [...lines]); else widgets.delete(key);
    },
    select: async () => undefined, input: async () => undefined, confirm: async () => false,
  } };
  let sequence = 0;
  try {
    createExtension(pi, {
      stateStore: state, discoverBackends: () => backends, outputDir: join(fixture.dir, "logs"),
      ...configure?.(fixture, state),
    });
    const restart = () => handlers.get("session_start")({}, ctx);
    await restart();
    await run({ fixture, pi, ctx, state, notices, statuses, widgets, widgetHistory, restart,
      command: async (args) => { const offset = notices.length; await commands.get("mxc").handler(args, ctx); return notices.slice(offset); },
      call: (name, args) => tools.get(name).execute(`slash-${++sequence}`, args, undefined, undefined, ctx),
    });
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    await fixture.cleanup();
  }
}

export function controlRuntime(fixture: Awaited<ReturnType<typeof createMxcFixture>>, overrides: Record<string, unknown> = {}) {
  return {
    candidate: pwsh!, workspace: fixture.workspace, policyId: "ui-control-policy",
    paths: { readonlyPaths: [fixture.reference], readwritePaths: [fixture.workspace], deniedPaths: [], scratchRoot: join(fixture.dir, "runner") },
    async check() {}, async dispose() {},
    createExecutor() { return { candidate: pwsh!, async exec(_command: string, _cwd: string, options: any) { options.onData?.(Buffer.from("CONTROL_EXECUTION\n")); return { exitCode: 0 }; } }; },
    async executeFile() { return { content: [{ type: "text", text: "CONTROL_FILE" }], details: undefined }; },
    ...overrides,
  };
}
