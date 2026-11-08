import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { createRequire } from "node:module";

const input = JSON.parse(process.argv[2]);
const moduleAt = (path) => import(pathToFileURL(join(input.piPackageRoot, path)).href);
const sdk = await moduleAt("dist/index.js");
const requirePeer = createRequire(join(input.piPackageRoot, "package.json"));
const { Container, visibleWidth } = await import(pathToFileURL(requirePeer.resolve("@earendil-works/pi-tui")).href);
const { InteractiveMode } = await moduleAt("dist/modes/interactive/interactive-mode.js");
const { initTheme } = await moduleAt("dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const settingsManager = sdk.SettingsManager.inMemory({
  compaction: { enabled: false }, retry: { enabled: false },
});
const loader = new sdk.DefaultResourceLoader({
  cwd: input.workspace, agentDir: input.agentDir, settingsManager,
  noExtensions: true, additionalExtensionPaths: [input.extensionRoot],
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await sdk.createAgentSession({
  cwd: input.workspace, agentDir: input.agentDir, resourceLoader: loader, settingsManager,
  sessionManager: sdk.SessionManager.inMemory(input.workspace),
});
// The actual Pi entry/notification rendering methods and components, without a
// second terminal, desktop actions, constructor startup, or a model request.
const surface = Object.create(InteractiveMode.prototype);
surface.runtimeHost = { session };
surface.chatContainer = new Container();
surface.ui = { requestRender() {} };
surface.outputPad = 1;
surface.toolOutputExpanded = false;
surface.lastStatusMessage = "";
const widgets = new Map();
const errors = [];
const appended = [];
session.extensionRunner.onError((error) => errors.push(error));
session.extensionRunner.setFlagValue("mxc-policy", input.policyPath);
const unsubscribe = session.subscribe((event) => {
  if (event.type === "entry_appended" && event.entry.type === "custom") {
    appended.push(event.entry);
    surface.addCustomEntryToChat(event.entry);
  }
});
const ui = {
  ...session.extensionRunner.getUIContext(),
  notify(message, kind) { surface.showExtensionNotify(message, kind); },
  setStatus() {},
  setWidget(key, value) { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
};
const rendered = (width) => surface.chatContainer.render(width).map(stripVTControlCharacters);
try {
  await session.bindExtensions({ uiContext: ui, mode: "tui" });
  const beforeMessages = JSON.stringify(session.messages);
  await session.prompt("/mxc paths");
  await session.prompt("/mxc help");
  assert.deepEqual(errors, []);
  // Replacing the two receipts with ui.notify(info) loses the first one in Pi.
  assert.equal(appended.length, 2, "Each completed command must append its own model-free TUI entry");
  assert.equal(surface.chatContainer.children.length, 2, "Each receipt needs a distinct native entry component");
  assert.ok(appended.some((entry) => JSON.stringify(entry.data).includes(JSON.stringify(input.workspace).slice(1, -1))));
  await session.prompt("/mxc on");
  assert.equal(appended.length, 3, "Fallback must produce one retained warning receipt, not disappear behind a transient notification");
  assert.equal(surface.chatContainer.children.length, 3);
  assert.match(rendered(120).join("\n"), /Invalid MXC policy profile JSON/);
  await session.prompt("/mxc off");
  assert.equal(appended.length, 4);
  assert.equal(surface.chatContainer.children.length, 4);
  const brief = appended.at(-1).data.text;
  assert.match(brief, /完成.*MXC off/);
  assert.equal(brief.split("\n").length, 1, brief);
  assert.doesNotMatch(brief, /当前实际|不迁移|不删除|下一步/);
  const widths = [24, 64, 120];
  const layouts = [];
  for (const width of widths) {
    const lines = rendered(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `Line exceeds terminal width ${width}`);
    const text = lines.join("\n");
    assert.match(text, /workspace/);
    assert.match(text, /\/mxc on/);
    assert.doesNotMatch(text, /renderer failed/);
    layouts.push({ width, lines });
  }
  initTheme("light", false);
  surface.chatContainer.invalidate();
  assert.match(rendered(120).join("\n"), /workspace/);
  assert.equal(widgets.size, 0);
  assert.equal(JSON.stringify(session.messages), beforeMessages, "UI receipts must not enter model context or start a turn");
  assert.equal(session.messages.filter((message) => message.role === "assistant").length, 0);
  console.log(JSON.stringify({
    sdkVersion: sdk.VERSION, receipts: appended.length, components: surface.chatContainer.children.length,
    widgetsRemaining: widgets.size, modelContextUnchanged: true, layouts, errors,
    scope: "Actual loader/AgentSession/entry events and Pi TUI components; no live terminal or keyboard acceptance",
  }));
} finally {
  unsubscribe();
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
