import { formatCreated, type TaskRegistry } from "./registry.ts";
import type { BackendExecutor, ExecutionIdentity } from "./operations.ts";

export const DEFAULT_THRESHOLD_MS = 5000;

export interface RunBashOptions {
  cwd: string;
  thresholdMs?: number;
  background?: boolean;
  name?: string;
  signal?: AbortSignal;
  executor?: BackendExecutor;
  env?: NodeJS.ProcessEnv;
  execution?: ExecutionIdentity;
  onUpdate?: (update: RunBashUpdate) => void;
}

export interface RunBashUpdate {
  content: [{ type: "text"; text: string }];
}
export interface RunBashResult {
  background: boolean;
  taskId?: string;
  text: string;
  exitCode: number | null;
}

export async function runBash(
  registry: TaskRegistry,
  command: string,
  opts: RunBashOptions,
): Promise<RunBashResult> {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const task = await registry.start(command, {
    cwd: opts.cwd,
    name: opts.name,
    executor: opts.executor,
    env: opts.env,
    execution: opts.execution,
    onData: opts.onUpdate
      ? (data) => {
          try {
            opts.onUpdate!({
              content: [{ type: "text", text: data.toString("utf8") }],
            });
          } catch {
            // A UI update failure must not fail the shell task.
          }
        }
      : undefined,
  });
  if (opts.background) {
    return {
      background: true,
      taskId: task.id,
      text: formatCreated(task),
      exitCode: null,
    };
  }
  if (opts.signal?.aborted) {
    await registry.kill(task.id);
    throw new Error("Command aborted");
  }
  let onAbort: (() => void) | undefined;
  const abortPromise = opts.signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Command aborted"));
        opts.signal!.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  try {
    const finished = abortPromise
      ? await Promise.race([
          registry.waitFor(task.id, thresholdMs),
          abortPromise,
        ])
      : await registry.waitFor(task.id, thresholdMs);
    const output = (await registry.logs(task.id)).trim();
    if (finished.status === "failed" && finished.exitCode === null) {
      throw new Error(output || "Command failed to start");
    }
    return {
      background: false,
      text: output || "(no output)",
      exitCode: finished.exitCode,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "Command aborted") {
      await registry.kill(task.id);
      throw err;
    }
    if (
      err instanceof Error &&
      err.message.startsWith("timed out waiting for task")
    ) {
      return {
        background: true,
        taskId: task.id,
        text: formatCreated(task),
        exitCode: null,
      };
    }
    throw err;
  } finally {
    if (opts.signal && onAbort)
      opts.signal.removeEventListener("abort", onAbort);
  }
}
