// Test-only preload, copied into a fixture RO domain. The production worker
// still runs in MXC; only the timing of real RW deletion is controlled here.
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
const original = promises.readdir;
promises.readdir = async (path, options) => {
  const entries = await original(path, options);
  if (basename(String(path)) === "workspace") {
    await promises.rm(join(String(path), "volatile.txt"), { force: true });
    await promises.rm(join(String(path), "volatile-dir"), { recursive: true, force: true });
  }
  return entries;
};
syncBuiltinESMExports();
