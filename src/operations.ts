import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { delimiter, join, win32 } from "node:path";
import { homedir } from "node:os";
import type { BackendCandidate } from "./backends.ts";

const POWERSHELL_ENCODING_PREFIX =
  "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

export interface ExecutionContextLike {
  sessionManager?: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
  };
  model?: {
    provider: string;
    id: string;
  };
  thinkingLevel?: string;
}

export interface ExecutionIdentity {
  mode: "native" | "mxc";
  shellPath: string;
  workspace: string;
  policyId?: string;
}

export interface ExecutionOptions {
  onData: (data: Buffer) => void;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface ExecutionResult {
  exitCode: number | null;
}

export interface BackendExecutor {
  readonly candidate: BackendCandidate;
  exec(
    command: string,
    cwd: string,
    options: ExecutionOptions,
  ): Promise<ExecutionResult>;
}

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getBinDir(): string {
  return join(getAgentDir(), "bin");
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return (
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH"
  );
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

export function createExecutionEnv(
  context?: ExecutionContextLike,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;

  const key = pathKey(env);
  const binDir = getBinDir();
  const currentPath = env[key] ?? "";
  const entries = currentPath.split(delimiter).filter(Boolean);
  if (!entries.some((entry) => samePath(entry, binDir))) {
    env[key] = [binDir, currentPath].filter(Boolean).join(delimiter);
  }

  if (context?.sessionManager) {
    env.PI_SESSION_ID = context.sessionManager.getSessionId();
    const sessionFile = context.sessionManager.getSessionFile();
    if (sessionFile) env.PI_SESSION_FILE = sessionFile;
  }
  if (context?.model) {
    env.PI_PROVIDER = context.model.provider;
    env.PI_MODEL = context.model.id;
  }
  if (context?.thinkingLevel) {
    env.PI_REASONING_LEVEL = context.thinkingLevel;
  }
  env.PYTHONUNBUFFERED ??= "1";
  return env;
}

function commandFor(candidate: BackendCandidate, command: string): string {
  return candidate.kind === "powershell"
    ? `${POWERSHELL_ENCODING_PREFIX}${command}`
    : command;
}

export function spawnArguments(
  candidate: BackendCandidate,
  command: string,
): { args: string[]; stdin?: string } {
  const resolvedCommand = commandFor(candidate, command);
  if (candidate.commandTransport === "stdin") {
    return { args: [...candidate.args], stdin: resolvedCommand };
  }
  return { args: [...candidate.args, resolvedCommand] };
}

function systemTaskkillPath(): string {
  const root = process.env.SystemRoot ?? process.env.WINDIR;
  return root && win32.isAbsolute(root)
    ? win32.join(root, "System32", "taskkill.exe")
    : "C:\\Windows\\System32\\taskkill.exe";
}

export function killProcessTree(child: ChildProcess | undefined): void {
  if (!child || child.pid === undefined) return;
  let treeKillSucceeded = false;
  if (process.platform === "win32") {
    try {
      const result = spawnSync(
        systemTaskkillPath(),
        ["/PID", String(child.pid), "/T", "/F"],
        {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      treeKillSucceeded = !result.error && result.status === 0;
    } catch {
      // Fall through to the root-process kill below.
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
      treeKillSucceeded = true;
    } catch {
      // The process may have already exited or may not be detached.
    }
  }
  if (!treeKillSucceeded) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited; the close handler settles the operation.
    }
  }
}

export function createBackendExecutor(
  candidate: BackendCandidate,
): BackendExecutor {
  return {
    candidate,
    exec(command, cwd, options) {
      return new Promise<ExecutionResult>((resolve, reject) => {
        const invocation = spawnArguments(candidate, command);
        let child: ChildProcess;
        let settled = false;
        let aborted = options.signal?.aborted ?? false;

        const cleanup = () => {
          options.signal?.removeEventListener("abort", onAbort);
        };
        const finish = (result: ExecutionResult) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => {
          aborted = true;
          killProcessTree(child);
        };

        try {
          child = spawn(candidate.path, invocation.args, {
            cwd,
            env: options.env ?? createExecutionEnv(),
            shell: false,
            stdio: [invocation.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32",
          });
        } catch (error) {
          fail(error);
          return;
        }

        child.stdout?.on("data", options.onData);
        child.stderr?.on("data", options.onData);
        child.stdin?.on("error", () => undefined);
        child.once("error", (error) => {
          if (aborted) finish({ exitCode: null });
          else fail(error);
        });
        child.once("close", (code) => {
          finish({ exitCode: aborted ? null : code });
        });
        options.signal?.addEventListener("abort", onAbort, { once: true });

        if (options.signal?.aborted || aborted) {
          onAbort();
        } else if (invocation.stdin !== undefined) {
          child.stdin?.end(invocation.stdin);
        }
      });
    },
  };
}
