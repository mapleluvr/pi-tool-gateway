import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type Severity = "info" | "warning" | "error";
const widgetKey = "pi-tool-gateway-operation";
const receiptType = "pi-tool-gateway-receipt";
interface Receipt { text: string; kind: Severity }

/** Presentation ownership only. Gateway/mode/Registry remain the source of truth. */
export function createCommandFeedback(pi: ExtensionAPI) {
  pi.registerEntryRenderer<Receipt>(receiptType, (entry, _options, theme) => {
    if (!entry.data || typeof entry.data.text !== "string") return undefined;
    const [heading, ...body] = entry.data.text.split("\n");
    const color = entry.data.kind === "error" ? "error" : entry.data.kind === "warning" ? "warning" : "accent";
    return new Text([theme.fg(color, heading), ...body].join("\n"), 0, 0);
  });

  function notify(ctx: ExtensionContext, text: string, kind: Severity = "info") {
    if (ctx.hasUI === false) return;
    if (ctx.mode === "tui") {
      try { pi.appendEntry<Receipt>(receiptType, { text, kind }); }
      catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`${text}\n[回执保存失败] ${cause}\n上述操作结果不变，未重放；本条仅临时通知，请用 /mxc status 查询。`, "warning");
      }
    } else ctx.ui?.notify?.(text, kind);
  }

  let epoch = 0;
  let sequence = 0;
  const cancel = new Map<number, () => void>();

  function start(ctx: ExtensionContext, title: string, initial = "正在处理") {
    const id = ++sequence;
    const ownEpoch = epoch;
    const started = Date.now();
    const ownWidgetKey = `${widgetKey}-${id}`;
    let stage = initial;
    let ended = false;
    let timer: NodeJS.Timeout | undefined;
    const live = () => !ended && ownEpoch === epoch;
    const render = () => {
      if (!live() || ctx.hasUI === false) return;
      ctx.ui?.setWidget?.(ownWidgetKey, [
        `[进行中] ${title} · 已等待 ${Math.floor((Date.now() - started) / 1000)}s`, stage,
      ]);
    };
    const clear = () => {
      if (ended) return;
      ended = true;
      if (timer) clearInterval(timer);
      cancel.delete(id);
      if (ctx.hasUI !== false) ctx.ui?.setWidget?.(ownWidgetKey, undefined);
    };
    cancel.set(id, clear);
    render();
    if (ctx.hasUI !== false && typeof ctx.ui?.setWidget === "function") {
      timer = setInterval(render, 1000);
      timer.unref?.();
    }
    return {
      rename(value: string) { title = value; render(); },
      stage(value: string) { stage = value; render(); },
      finish(result: string, body: string, kind: Severity = "info", emit = true) {
        const mayEmit = live();
        clear();
        if (mayEmit && emit) notify(ctx, `[${result}] ${title}${body ? `\n${body}` : ""}`, kind);
      },
      live,
    };
  }

  function reset() {
    epoch++;
    for (const clear of [...cancel.values()]) clear();
  }
  return { start, reset, notify };
}
export type CommandOperation = ReturnType<ReturnType<typeof createCommandFeedback>["start"]>;
