// Trusted one-shot worker. Target path resolution and complete Pi execution
// (including its mutation queue) happen in this ProcessContainer, not the host.
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function auditFilesystem(workspaces, protectedFileIds) {
  const protectedIds = new Set(protectedFileIds);
  const pending = [...workspaces];
  while (pending.length) {
    const path = pending.pop();
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === "ENOENT" && !workspaces.includes(path)) continue;
      throw error;
    }
    pending.push(...entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => join(path, entry.name)));
    const files = entries.filter((entry) => entry.isFile()).map((entry) => join(path, entry.name));
    for (let index = 0; index < files.length; index += 32) {
      const group = files.slice(index, index + 32);
      const metadata = await Promise.all(group.map(async (file) => {
        try { return await lstat(file, { bigint: true }); }
        catch (error) { if (error?.code === "ENOENT") return null; throw error; }
      }));
      for (let offset = 0; offset < group.length; offset++) {
        const file = metadata[offset];
        if (file && file.isFile() && file.nlink > 1n && protectedIds.has(`${file.dev}:${file.ino}`)) {
          throw new Error(`RW hard link aliases a protected file object: ${group[offset]}`);
        }
      }
    }
  }
  return { content: [{ type: "text", text: "Protected/RW file identities are disjoint" }] };
}

let kind = "runtime";
try {
  const request = JSON.parse(await readFile(process.argv[2], "utf8"));
  let result;
  if (request.audit) {
    result = await auditFilesystem(request.audit.writablePaths, request.audit.protectedFileIds);
  } else {
    const pi = await import(pathToFileURL(join(request.piPackageRoot, "dist", "index.js")).href);
    const factories = {
      read: pi.createReadToolDefinition,
      write: pi.createWriteToolDefinition,
      edit: pi.createEditToolDefinition,
    };
    const factory = factories[request.tool];
    if (!factory) throw new Error("Unsupported MXC file operation");
    const tool = factory(request.cwd);
    kind = "operation";
    result = await tool.execute(
      `mxc-file-${process.pid}`, request.params, undefined, undefined,
      { cwd: request.cwd, model: request.model },
    );
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false, kind,
    error: { message: error instanceof Error ? error.message : String(error), code: error?.code },
  }));
  process.exitCode = 1;
}
