import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdirSync } from "node:fs";

import { tmpdir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";
import {
  createCustomCandidate,
  discoverBackends as discoverSystemBackends,
  formatBackend,
  isShellFile,
  resolveBackend,
  type BackendCandidate,
  type BackendId,
  type BackendSelection,
} from "./src/backends.ts";
import {
  createBackendStateStore,
  type BackendStateLoad,
  type BackendStateStore,
} from "./src/state.ts";
import { createToolGateway, type GatewayDependencies } from "./src/gateway.ts";
import type { CommandOperation } from "./src/feedback.ts";
import { isMxcShell } from "./src/mxc/mode.ts";
import {
  DEFAULT_LOGS_MAX_BYTES,
  createTaskRegistry,
  type TaskRegistry,
} from "./src/registry.ts";
import { DEFAULT_THRESHOLD_MS, runBash } from "./src/exec.ts";

const DEFAULT_OUTPUT_DIR = join(tmpdir(), "pi-tool-gateway");

export interface ExtensionDependencies {
  stateStore?: BackendStateStore;
  discoverBackends?: () => BackendCandidate[];
  outputDir?: string;
  gateway?: GatewayDependencies;
}

interface ActiveBackend {
  state: BackendStateLoad;
  candidates: BackendCandidate[];
  candidate?: BackendCandidate;
  error?: string;
}

function thresholdMs(): number {
  const raw = Number(process.env.PI_TOOL_GATEWAY_THRESHOLD_MS ?? process.env.PI_BASH_BG_THRESHOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_THRESHOLD_MS;
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text", text } as const], details };
}

const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Foreground wait budget in seconds before auto-converting to a background task (default ~5s)",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Start as a background task immediately and return its task id",
    }),
  ),
});

const bgRunSchema = Type.Object({
  command: Type.String({
    description: "Shell command to run in the background",
  }),
  name: Type.Optional(
    Type.String({ description: "Short human-readable task name" }),
  ),
});

const bgStatusSchema = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description: "Task id or id prefix; omit to list all tasks",
    }),
  ),
});

const bgLogsSchema = Type.Object({
  taskId: Type.String({ description: "Task id or id prefix" }),
  maxBytes: Type.Optional(
    Type.Number({ description: "Max output bytes to return (default 20000)" }),
  ),
});

const bgKillSchema = Type.Object({
  taskId: Type.String({ description: "Task id or id prefix" }),
});

const bgWaitSchema = Type.Object({
  taskId: Type.String({ description: "Task id or id prefix" }),
  timeoutSeconds: Type.Number({
    description:
      "Wait budget in seconds (required, 1-3600; further ceiling enforced)",
  }),
});

function backendSyntax(candidate: BackendCandidate | undefined): string {
  if (!candidate) return "No supported shell backend is currently available.";
  if (candidate.kind === "powershell") {
    return `Write commands using ${candidate.label} PowerShell syntax; do not use Bash built-ins.`;
  }
  return `Write commands using Bash syntax through ${candidate.label}.`;
}

function backendDescription(
  candidate: BackendCandidate | undefined,
  error: string | undefined,
): string {
  const target = candidate
    ? `${candidate.label} at ${candidate.path}`
    : "no supported backend";
  const failure = error ? ` ${error}` : "";
  return `Execute commands through ${target}. Returns stdout/stderr. Commands running longer than ~5s auto-convert to background tasks: the result is 'background task created' with a taskId — follow up with bg_status/bg_logs/bg_kill.${failure}`;
}

function backendPromptSnippet(candidate: BackendCandidate | undefined): string {
  if (!candidate) return "Shell backend unavailable";
  return `Execute ${candidate.kind === "powershell" ? "PowerShell" : "Bash"} commands (auto-backgrounds after ~5s)`;
}

function annotateBackendWarning(text: string, warning: string | undefined): string {
  return warning ? `${warning}\n\n${text}` : text;
}


function backendKey(active: ActiveBackend): string {
  return `${active.state.selection.backend}:${active.candidate?.path ?? ""}:${active.error ?? ""}:${active.state.warning ?? ""}`;
}

function isAbsoluteCandidatePath(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value);
}

function selectionFromArgument(argument: string): BackendSelection {
  const lower = argument.toLowerCase();
  if (
    lower === "auto" ||
    lower === "pwsh7" ||
    lower === "gitbash" ||
    lower === "powershell51"
  ) {
    return { backend: lower as Exclude<BackendId, "custom"> };
  }
  if (lower === "cmd" || lower === "cmd.exe") {
    throw new Error("cmd.exe is not an allowed shell backend");
  }
  if (!isAbsoluteCandidatePath(argument)) {
    throw new Error(
      "Expected auto, pwsh7, gitbash, powershell51, or an absolute Bash/PowerShell path",
    );
  }
  const candidate = createCustomCandidate(argument);
  return { backend: "custom", shellPath: candidate.path };
}

export function createExtension(
  pi: ExtensionAPI,
  dependencies: ExtensionDependencies = {},
): void {
  const stateStore = dependencies.stateStore ?? createBackendStateStore();
  const discover = dependencies.discoverBackends ?? discoverSystemBackends;
  const outputDir = dependencies.outputDir ?? DEFAULT_OUTPUT_DIR;
  let registry: TaskRegistry | undefined;
  let activeKey = "";
  let active: ActiveBackend | undefined;
  let cachedCandidates: BackendCandidate[] | undefined;
  let cachedSelectionKey = "";
  let initialized = false;
  const notifiedWarnings = new Set<string>();
  const gateway = createToolGateway(
    pi, dependencies.gateway ?? {}, (ctx) => syncActive(ctx).candidate,
    () => registry?.list() ?? [], (taskId) => getRegistry().kill(taskId),
  );

  function selectionKey(selection: BackendSelection): string {
    return `${selection.backend}:${selection.shellPath ?? ""}`;
  }

  function getRegistry(): TaskRegistry {
    if (!registry) {
      mkdirSync(outputDir, { recursive: true });
      registry = createTaskRegistry({ dir: outputDir });
    }
    return registry;
  }

  function loadBackend(forceDiscovery = false): ActiveBackend {
    const state = stateStore.read();
    const currentSelectionKey = selectionKey(state.selection);
    const canReuse = Boolean(
      !forceDiscovery &&
        cachedCandidates &&
        cachedSelectionKey === currentSelectionKey &&
        active &&
        !active.error &&
        (!active.candidate || isShellFile(active.candidate.path)),
    );
    if (canReuse) {
      return { ...active!, state, candidates: cachedCandidates! };
    }

    let candidates: BackendCandidate[] = [];
    try {
      candidates = discover();
    } catch (error) {
      cachedCandidates = candidates;
      cachedSelectionKey = currentSelectionKey;
      return {
        state,
        candidates,
        error: `Backend discovery failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    cachedCandidates = candidates;
    cachedSelectionKey = currentSelectionKey;
    try {
      return {
        state,
        candidates,
        candidate: resolveBackend(state.selection, candidates),
      };
    } catch (error) {
      return {
        state,
        candidates,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function notifyWarning(ctx: any, warning: string | undefined): void {
    if (!warning || notifiedWarnings.has(warning)) return;
    if (ctx?.ui?.notify) {
      ctx.ui.notify(warning, "warning");
      notifiedWarnings.add(warning);
    }
  }

  function registerBashTool(
    candidate: BackendCandidate | undefined,
    error: string | undefined,
    warning?: string,
  ): void {
    const diagnostic = [error, warning].filter(Boolean).join(" ") || undefined;
    pi.registerTool({
      name: "bash",
      label: "bash",
      description: backendDescription(candidate, diagnostic),
      promptSnippet: backendPromptSnippet(candidate),
      promptGuidelines: [
        backendSyntax(candidate),
        "Commands running longer than ~5s return 'background task created' with a taskId instead of blocking; use bg_status/bg_logs/bg_kill to follow up.",
      ],
      parameters: bashSchema,
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const current = ensureBackend(ctx);
        const reg = getRegistry();
        const cwd = ctx?.cwd ?? process.cwd();
        const limitMs =
          typeof params.timeout === "number" &&
          Number.isFinite(params.timeout) &&
          params.timeout > 0
            ? params.timeout * 1000
            : thresholdMs();
        try {
          const route = await gateway.execution(current.candidate!, ctx, signal);
          const result = await runBash(reg, params.command, {
            cwd,
            thresholdMs: limitMs,
            background: params.background,
            signal: signal ?? undefined,
            executor: route.executor,
            env: route.env,
            execution: route.identity,
            onUpdate: onUpdate
              ? (update) => onUpdate(update as any)
              : undefined,
          });
          const warning = [current.state.warning, route.warning].filter(Boolean).join("\n") || undefined;
          const output = annotateBackendWarning(result.text, warning);
          if (result.background) {
            return textResult(output, { taskId: result.taskId, execution: route.identity });
          }
          if (result.exitCode !== 0 && result.exitCode !== null) {
            throw new Error(
              `${output}\n\nCommand exited with code ${result.exitCode}`,
            );
          }
          return textResult(output, { execution: route.identity });
        } catch (err) {
          if (err instanceof Error && err.message === "Command aborted") {
            throw new Error("Command aborted");
          }
          throw err;
        }
      },
    });
  }

  function syncActive(
    ctx?: any,
    forceDiscovery = false,
  ): ActiveBackend {
    const next = loadBackend(forceDiscovery);
    const nextKey = backendKey(next);
    if (!active || activeKey !== nextKey) {
      active = next;
      activeKey = nextKey;
      if (initialized) {
        registerBashTool(next.candidate, next.error, next.state.warning);
      }

    }
    notifyWarning(ctx, next.state.warning);
    return next;
  }

  function ensureBackend(ctx?: any): ActiveBackend & { candidate: BackendCandidate } {
    const current = syncActive(ctx);
    if (!current.candidate) {
      throw new Error(
        current.error ??
          "No shell backend available. Install PowerShell 7, Git Bash, or PowerShell 5.1.",
      );
    }
    return current as ActiveBackend & { candidate: BackendCandidate };
  }

  async function applySelection(
    selection: BackendSelection,
    ctx: any,
    operation: CommandOperation,
  ): Promise<void> {
    let saved = false;
    try {
      operation.stage("正在探测选定 Shell");
      const candidates = discover();
      const candidate = resolveBackend(selection, candidates);
      operation.stage("正在保存 Shell 选择");
      stateStore.write(selection);
      saved = true;
      cachedCandidates = candidates;
      cachedSelectionKey = selectionKey(selection);
      active = { state: { selection }, candidates, candidate };
      activeKey = backendKey(active);
      registerBashTool(candidate, undefined);
      operation.stage("Shell 已保存；正在刷新实际执行模式");
      await gateway.refresh(ctx, operation);
      let choice: string = selection.backend;
      if (selection.backend === "auto") choice = `auto → ${candidate.id}`;
      else if (selection.backend === "custom") choice = candidate.path;
      operation.finish("完成", [`已保存 Shell: ${choice}`, gateway.oldTaskNotice()].filter(Boolean).join("\n"));
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const state = saved
        ? `Shell 选择已保存: ${selection.backend}；执行模式刷新失败。`
        : "Shell 选择未保存。";
      operation.finish(saved ? "已保存，刷新失败" : "拒绝", `${state}\n原因: ${cause}\n下一步：修正问题后 /bash-select，或 /mxc status 查询。`, saved ? "warning" : "error");
      if (ctx?.hasUI === false) throw error;
    }
  }

  function selectionOptions(
    loaded: ActiveBackend,
  ): { text: string; selection: BackendSelection }[] {
    const options: { text: string; selection: BackendSelection }[] = [];
    let autoCandidate: BackendCandidate | undefined;
    try {
      autoCandidate = resolveBackend("auto", loaded.candidates);
    } catch {
      // Keep auto visible even when no backend is installed.
    }
    const current = loaded.state.selection;
    const eligibility = (candidate: BackendCandidate | undefined) => !candidate ? "不可执行" : isMxcShell(candidate) ? "MXC 候选" : "仅 Native";
    const marker = (backend: BackendId) =>
      current.backend === backend ? "[current] " : "";
    options.push({
      text: `${marker("auto")}auto — ${
        autoCandidate ? formatBackend(autoCandidate) : "no available backend"
      } | ${eligibility(autoCandidate)}`,
      selection: { backend: "auto" },
    });
    const seen = new Set<string>();
    for (const candidate of loaded.candidates) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      options.push({
        text: `${marker(candidate.id)}${candidate.id} — ${formatBackend(candidate)} | ${eligibility(candidate)}`,
        selection: { backend: candidate.id },
      });
    }
    if (current.backend === "custom" && current.shellPath) {
      options.push({
        text: `[current] custom — ${current.shellPath} | ${eligibility(loaded.candidate)}`,
        selection: { ...current },
      });
    }
    return options;
  }

  pi.on("session_shutdown", async () => {
    registry?.dispose();
    registry = undefined;
    await gateway.dispose();
  });

  pi.registerCommand("bash-select", {
    description:
      "Choose the shell backend for the bash tool (PowerShell 7 / Git Bash / PowerShell 5.1)",
    getArgumentCompletions(argumentPrefix: string) {
      const prefix = argumentPrefix.trim().toLowerCase();
      const loaded = syncActive();
      const values = [
        "auto",
        "pwsh7",
        "gitbash",
        "powershell51",
        ...loaded.candidates.map((candidate) => candidate.path),
        ...(loaded.candidate?.id === "custom" && loaded.candidate.path
          ? [loaded.candidate.path]
          : []),
      ];
      return [...new Set(values)]
        .filter((value) => value.toLowerCase().startsWith(prefix))
        .map((value) => ({
          value,
          label: value,
        }));
    },
    async handler(args: string, ctx: any) {
      const argument = args.trim();
      const operation = gateway.feedback.start(ctx, "选择 Shell", "正在解析 Shell 选择");
      try {
        let selection: BackendSelection;
        if (argument) selection = selectionFromArgument(argument);
        else {
          if (ctx?.hasUI === false || typeof ctx?.ui?.select !== "function") throw new Error("Use /bash-select auto|pwsh7|gitbash|powershell51|<absolute-shell-path>");
          operation.stage("正在发现可用 Shell");
          const loaded = syncActive(ctx, true);
          const openedSelection = selectionKey(loaded.state.selection);
          const openedGeneration = gateway.snapshot().generation;
          const choices = selectionOptions(loaded);
          operation.stage("等待选择 Shell");
          const selected = await ctx.ui.select("Select bash backend — 选择 Shell", choices.map((choice) => choice.text));
          if (!operation.live()) return;
          if (openedGeneration !== gateway.snapshot().generation || openedSelection !== selectionKey(stateStore.read().selection)) {
            operation.finish("被较新配置取代", "旧 Shell 选择未保存；请重新 /bash-select。");
            return;
          }
          if (!selected) { operation.finish("已取消", ""); return; }
          const choice = choices.find((value) => value.text === selected);
          if (!choice) throw new Error("Unknown backend selection");
          selection = choice.selection;
        }
        await applySelection(selection, ctx, operation);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        operation.finish("拒绝", `Shell 选择未保存。\n原因: ${cause}\n用法：/bash-select auto|pwsh7|gitbash|powershell51|<absolute-shell-path>`, "error");
        if (ctx?.hasUI === false) throw error;
      }
    },
  });

  const initial = syncActive();
  active = initial;
  activeKey = backendKey(initial);
  registerBashTool(initial.candidate, initial.error, initial.state.warning);
  initialized = true;

  pi.registerTool({
    name: "bg_run",
    label: "bg_run",
    description:
      "Start a shell command as a background task. Returns 'background task created' with a taskId immediately; follow up with bg_status/bg_logs/bg_kill.",
    promptSnippet: "Run shell commands in the background",
    parameters: bgRunSchema,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const current = ensureBackend(ctx);
      const reg = getRegistry();
      const route = await gateway.execution(current.candidate, ctx);
      const result = await runBash(reg, params.command, {
        cwd: ctx?.cwd ?? process.cwd(),
        background: true,
        name: params.name,
        executor: route.executor,
        env: route.env,
        execution: route.identity,
        onUpdate: onUpdate
          ? (update) => onUpdate(update as any)
          : undefined,
      });
      const warning = [current.state.warning, route.warning].filter(Boolean).join("\n") || undefined;
      return textResult(
        annotateBackendWarning(result.text, warning),
        { taskId: result.taskId, execution: route.identity },
      );
    },
  });

  pi.registerTool({
    name: "bg_status",
    label: "bg_status",
    description: "Show background task status. Omit taskId to list all tasks.",
    parameters: bgStatusSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const reg = getRegistry();
      if (params.taskId) {
        const t = reg.get(params.taskId);
        return textResult(
          [
            `taskId: ${t.id}`,
            `name: ${t.name}`,
            `status: ${t.status}`,
            `exitCode: ${t.exitCode ?? "-"}`,
            `command: ${t.command}`,
            ...(t.execution ? [`execution: ${t.execution.mode} (${t.execution.shellPath})`, `policyId: ${t.execution.policyId ?? "-"}`] : []),
          ].join("\n"),
          { taskId: t.id, status: t.status, execution: t.execution },
        );
      }
      const tasks = reg.list();
      if (tasks.length === 0)
        return textResult("(no background tasks)", { count: 0 });
      return textResult(
        tasks.map((t) => `${t.id} [${t.status}] ${t.name}`).join("\n"),
        { count: tasks.length },
      );
    },
  });

  pi.registerTool({
    name: "bg_logs",
    label: "bg_logs",
    description: "Read bounded output of a background task.",
    parameters: bgLogsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const reg = getRegistry();
      const maxBytes =
        typeof params.maxBytes === "number" &&
        Number.isFinite(params.maxBytes) &&
        params.maxBytes > 0
          ? Math.min(Math.floor(params.maxBytes), 1_000_000)
          : DEFAULT_LOGS_MAX_BYTES;
      const logs = await reg.logs(params.taskId, maxBytes);
      const t = reg.get(params.taskId);
      return textResult(logs || "(no output yet)", {
        taskId: t.id,
        status: t.status,
      });
    },
  });

  pi.registerTool({
    name: "bg_kill",
    label: "bg_kill",
    description: "Stop a running background task.",
    parameters: bgKillSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const reg = getRegistry();
      const before = reg.get(params.taskId);
      if (before.status !== "running") {
        return textResult(`task ${before.id} already ${before.status}`, {
          taskId: before.id,
          status: before.status,
        });
      }
      const after = await reg.kill(params.taskId);
      const message = after.status === "running"
        ? `cancellation requested for ${after.id}; process exit is not confirmed, use bg_status/bg_join`
        : `killed ${after.id}`;
      return textResult(message, {
        taskId: after.id,
        status: after.status,
      });
    },
  });

  pi.registerTool({
    name: "bg_join",
    label: "bg_join",
    description:
      "Wait for a background shell task to reach a terminal state, then show its status plus output tail. (pi-subagents owns bg_wait for subagent runs; this one is for shell tasks.)",
    parameters: bgWaitSchema,
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const reg = getRegistry();
      if (
        typeof params.timeoutSeconds !== "number" ||
        !Number.isFinite(params.timeoutSeconds)
      ) {
        throw new Error(
          "timeoutSeconds is required: pass an explicit wait budget in seconds (1-3600).",
        );
      }
      const timeoutMs =
        Math.min(Math.max(Math.floor(params.timeoutSeconds), 1), 3600) * 1000;
      if (signal?.aborted) throw new Error("Command aborted");
      let onAbort: (() => void) | undefined;
      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error("Command aborted"));
            signal.addEventListener("abort", onAbort, { once: true });
          })
        : undefined;
      try {
        const t = abortPromise
          ? await Promise.race([
              reg.waitFor(params.taskId, timeoutMs),
              abortPromise,
            ])
          : await reg.waitFor(params.taskId, timeoutMs);
        const tail = await reg.logs(params.taskId, 2000);
        return textResult(
          [
            `taskId: ${t.id}`,
            `status: ${t.status}`,
            `exitCode: ${t.exitCode ?? "-"}`,
            "--- tail ---",
            tail.trim() || "(no output)",
          ].join("\n"),
          { taskId: t.id, status: t.status },
        );
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.startsWith("timed out waiting for task")
        ) {
          const t = reg.get(params.taskId);
          return textResult(`still running: ${t.id} [${t.status}] ${t.name}`, {
            taskId: t.id,
            status: t.status,
          });
        }
        throw err;
      } finally {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  createExtension(pi);
}
