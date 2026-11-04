import { lstat, readdir, readlink, stat } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { MxcRuntimeUnavailable } from "./errors.ts";

function inside(path: string, root: string): boolean {
  const relative = win32.relative(root, path);
  return relative === "" || (!win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\"));
}

/** Management metadata only: these roots come from trusted runtime/policy inputs,
 * never from a model tool's target. RW entries are inspected by the MXC worker. */
export async function collectProtectedFileIds(
  roots: string[], workspaces: string[], canonicalPath: (path: string) => Promise<string>, signal: AbortSignal, scratchRoot: string,
): Promise<string[]> {
  const volumes = new Set(await Promise.all(workspaces.map(async (workspace) => (await stat(workspace, { bigint: true })).dev)));
  const ids = new Set<string>();
  const seen = new Set<string>();
  const pending = [...roots];
  const inspect = async (path: string) => {
    if (signal.aborted) throw new Error("Operation aborted");
    try {
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink()) {
        const destination = win32.resolve(dirname(path), await readlink(path));
        const target = await canonicalPath(destination);
        if (workspaces.some((workspace) => inside(target, workspace) || inside(workspace, target))) {
          throw new MxcRuntimeUnavailable(`Protected resource resolves into the RW workspace: ${path}`);
        }
        if (inside(target, scratchRoot) || inside(scratchRoot, target)) {
          throw new MxcRuntimeUnavailable(`Protected resource resolves into private RW control storage: ${path}`);
        }
        pending.push(target);
      } else if (metadata.isDirectory()) {
        const entries = await readdir(path, { withFileTypes: true });
        const files = entries.filter((entry) => entry.isFile()).map((entry) => join(path, entry.name));
        pending.push(...entries.filter((entry) => !entry.isFile()).map((entry) => join(path, entry.name)));
        for (let index = 0; index < files.length; index += 32) {
          await Promise.all(files.slice(index, index + 32).map(inspect));
        }
      } else if (metadata.isFile() && volumes.has(metadata.dev) && metadata.nlink > 1n) {
        ids.add(`${metadata.dev}:${metadata.ino}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  while (pending.length) {
    const path = pending.pop()!;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    await inspect(path);
  }
  return [...ids];
}
