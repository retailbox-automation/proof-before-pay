// MCP App view shared by the six proofpay cards (ui://proofpay/<view>.html). Bundled by build.ts and
// inlined into each HTML file; <body data-view="..."> names the card. Uses the official App class
// (ext-apps) over the host's postMessage bridge. Text goes in with textContent only (never innerHTML).
// A tap on a CTA sends a ui/message to the host, which treats it as the user's next turn.
import { App } from "@modelcontextprotocol/ext-apps";

type Mode = "live" | "fixture" | "sandbox" | "simulated";
type Row = { state: string; label: string; detail?: string; source?: string; mode?: Mode; kind?: string; action?: { label: string; message: string } };
type Field = { label: string; value: string; source?: string; mode?: Mode; kind?: string };
type Card = {
  view: string; layout: string; title: string; subtitle?: string; hero?: { text: string; kind: string };
  rows: Row[]; more?: { label: string; rows: Row[] }; fields?: Field[]; note?: string; footer?: string;
  stacks?: { kind: string; label: string; count: number; amount: string }[];
  breakdown?: { label: string; value: string; kind: string }[];
  action?: { label: string; message: string };
};

const VIEW = document.body.dataset.view ?? "unknown";
const root = document.getElementById("root") as HTMLElement;
const MARK: Record<string, string> = { ok: "✓", bad: "✗", struck: "✗", pending: "…", info: "•" };
const ZOOM: Record<string, number> = { "echo-show-8": 1.667, "echo-show-15": 1.667 }; // 1280x800 / 768x480 base canvas
let renders = 0;

const app = new App({ name: `proofpay-${VIEW}`, version: "0.1.0" });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function badge(mode: Mode | undefined): HTMLElement | null {
  return mode ? el("span", { class: "badge", "data-mode": mode }, mode.toUpperCase()) : null;
}

async function say(message: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const r = await app.sendMessage({ role: "user", content: [{ type: "text", text: message }] });
    if (r.isError) btn.disabled = false;
  } catch (e) {
    console.error("[view] sendMessage failed", e);
    btn.disabled = false;
  }
}

function rowEl(r: Row): HTMLLIElement {
  const li = el("li", { class: "row", "data-state": r.state, "data-kind": r.kind ?? "" });
  li.append(el("span", { class: "mark", "aria-hidden": "true" }, MARK[r.state] ?? "•"));
  const txt = el("div", { class: "txt" });
  txt.append(el("div", { class: "label" }, r.label));
  if (r.detail) txt.append(el("div", { class: "detail" }, r.detail));
  li.append(txt);
  if (r.action) {
    const b = el("button", { type: "button", "data-message": r.action.message }, r.action.label);
    b.addEventListener("click", () => say(r.action!.message, b));
    li.append(b);
  }
  if (r.source || r.mode) {
    const s = el("div", { class: "src" }, r.source ? `Source: ${r.source}` : "");
    const bd = badge(r.mode);
    if (bd) s.append(bd);
    li.append(s);
  }
  return li;
}

function render(card: Card): void {
  const art = el("article", { class: "card", id: "card", "data-view": card.view, "data-layout": card.layout });
  const head = el("header");
  head.append(el("h1", { id: "title" }, card.title));
  if (card.subtitle) head.append(el("p", { class: "subtitle", id: "subtitle" }, card.subtitle));
  art.append(head);
  if (card.hero) art.append(el("div", { class: "hero", id: "hero", "data-kind": card.hero.kind }, card.hero.text));
  if (card.stacks?.length) {
    const st = el("div", { class: "stacks", id: "stacks" });
    for (const x of card.stacks) {
      const d = el("div", { class: "stack", "data-kind": x.kind });
      d.append(el("div", { class: "stack-label" }, x.label), el("div", { class: "stack-amount" }, x.amount), el("div", { class: "stack-count" }, `${x.count} item${x.count === 1 ? "" : "s"}`));
      st.append(d);
    }
    art.append(st);
  }
  if (card.rows.length) {
    const ul = el("ul", { class: "rows", id: "rows" });
    for (const r of card.rows) ul.append(rowEl(r));
    art.append(ul);
    if (card.more) {
      const more = el("button", { type: "button", class: "more", id: "more" }, card.more.label);
      more.addEventListener("click", () => { for (const r of card.more!.rows) ul.append(rowEl(r)); more.remove(); fit(); });
      art.append(more);
    }
  }
  if (card.fields?.length) {
    const dl = el("dl", { class: "fields", id: "fields" });
    for (const f of card.fields) {
      const d = el("div", { class: "field", "data-kind": f.kind ?? "" });
      d.append(el("dt", {}, f.label));
      const dd = el("dd", {}, f.value);
      if (f.source) dd.append(el("span", { class: "src" }, ` · ${f.source}`));
      const bd = badge(f.mode);
      if (bd) dd.append(bd);
      d.append(dd);
      dl.append(d);
    }
    art.append(dl);
  }
  if (card.breakdown?.length) {
    const dl = el("dl", { class: "breakdown", id: "breakdown" });
    for (const b of card.breakdown) {
      const d = el("div", { class: "line", "data-kind": b.kind });
      d.append(el("dt", {}, b.label), el("dd", {}, b.value));
      dl.append(d);
    }
    art.append(dl);
  }
  if (card.note) art.append(el("pre", { class: "note", id: "note" }, card.note));
  if (card.footer) art.append(el("div", { class: "footer", id: "footer" }, card.footer));
  if (card.action) {
    const b = el("button", { type: "button", class: "action", id: "action", "data-message": card.action.message }, card.action.label);
    b.addEventListener("click", () => say(card.action!.message, b));
    art.append(b);
  }
  root.replaceChildren(art);
  fit();
  renders += 1;
  document.body.dataset.rendered = String(renders);
}

let deviceZoom = 1;
let maxHeight = Infinity;

/** One root scale: the device-class zoom, reduced only as far as needed to fit the host's container height.
 *  body.scrollHeight is the unzoomed layout height at the current zoom (wrapping depends on zoom), so iterate. */
function fit(): void {
  const root = document.documentElement;
  let zoom = deviceZoom;
  for (let i = 0; i < 4; i++) {
    root.style.setProperty("zoom", String(zoom));
    if (!Number.isFinite(maxHeight)) break;
    const onScreen = (document.body.scrollHeight + 14) * zoom; // + card margins
    if (onScreen <= maxHeight) break;
    zoom = Math.max(0.8, Math.floor(zoom * (maxHeight / onScreen) * 100) / 100);
  }
  document.body.dataset.zoom = String(zoom);
}

function applyHostContext(ctx: Record<string, unknown> | undefined): void {
  if (!ctx) return;
  if (ctx.theme === "dark" || ctx.theme === "light") document.documentElement.dataset.theme = ctx.theme;
  const dc = typeof ctx.deviceClass === "string" ? ctx.deviceClass : undefined;
  if (!dc) console.warn("[view] hostContext has no deviceClass; using zoom 1");
  deviceZoom = dc ? ZOOM[dc] ?? 1 : 1;
  const dims = ctx.containerDimensions as { maxHeight?: number } | undefined;
  maxHeight = typeof dims?.maxHeight === "number" ? dims.maxHeight : Infinity;
  document.body.dataset.deviceClass = dc ?? "";
  fit();
}

app.ontoolinput = () => {
  if (!renders) root.replaceChildren(el("p", { class: "subtitle", id: "loading" }, "Checking…"));
};
app.ontoolresult = (result) => {
  const card = (result.structuredContent as { card?: Card } | undefined)?.card;
  if (!card) { root.replaceChildren(el("p", { class: "subtitle" }, "No card data.")); return; }
  render(card);
};
app.onhostcontextchanged = (ctx) => applyHostContext(ctx as Record<string, unknown>);
app.ontoolcancelled = (p) => { root.replaceChildren(el("p", { class: "subtitle" }, `Cancelled: ${p.reason ?? "unknown"}`)); };
app.onerror = (e) => { console.error("[view]", e); };
app.connect().then(() => {
  applyHostContext(app.getHostContext() as Record<string, unknown> | undefined);
  document.body.dataset.connected = "1";
});
