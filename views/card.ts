// MCP App view shared by the proofpay cards (ui://proofpay/<view>.html). Bundled by build.ts and inlined into each
// HTML file; <body data-view="..."> names the card. Uses the official App class (ext-apps) over the host's
// postMessage bridge. Text goes in with textContent only (never innerHTML). A tap on a CTA sends a ui/message to the
// host, which treats it as the user's next turn ("Pay for this order" starts Alexa+ checkout).
// Layouts follow the image-first references (docs/ui/2026-10-10-proofpay-echo-show/html/<screen>/); content comes
// from the tool result. No mode badges on cards (developer view only, SPEC §7.3).
import { App } from "@modelcontextprotocol/ext-apps";

type Action = { label: string; message: string };
type Row = {
  state: string; label: string; detail?: string; source?: string; kind?: string; money?: string; status?: string;
  meta?: { rating: string; reviews: string; estimate: string }; icon?: string; action?: Action;
};
type Panel = { kind: string; state: string; label: string; amount: string; breakdown?: { label: string; value: string; kind: string }[]; rows?: Row[]; action?: Action; note?: string };
type Section = { kind: string; heading?: string; rows: Row[]; more?: { label: string; rows: Row[] }; total?: string; action?: Action & { style?: string }; note?: { text: string; kind: string } };
type Card = {
  view: string; layout: string; title: string; subtitle?: string; tag?: string; panels?: Panel[]; sections?: Section[];
  rows: Row[]; more?: { label: string; rows: Row[] }; fields?: { label: string; value: string; source?: string; kind?: string }[];
  note?: string; footer?: string; action?: Action & { style?: string };
};

const VIEW = document.body.dataset.view ?? "unknown";
const root = document.getElementById("root") as HTMLElement;
const ZOOM: Record<string, number> = { "echo-show-8": 1.667, "echo-show-15": 1.667 }; // 1280x800 / 768x480 base canvas
const SVG = "http://www.w3.org/2000/svg";
let renders = 0;

const app = new App({ name: `proofpay-${VIEW}`, version: "0.3.0" });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
function svg(tag: string, attrs: Record<string, string>, children: SVGElement[] = []): SVGElement {
  const e = document.createElementNS(SVG, tag) as SVGElement;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}

// ---------- icons: each status has its own shape and an accessible label (never colour-only) ----------
const LABEL: Record<string, string> = { ok: "Proven", warn: "Waits", pending: "Pending", info: "Info", todo: "To be proven", doc: "Evidence", calendar: "Visit", struck: "Left out" };
function icon(kind: string, cls = "ic"): SVGElement {
  const k = kind === "bad" ? "warn" : kind === "struck" ? "warn" : kind;
  const label = LABEL[kind] ?? LABEL[k] ?? kind;
  const base = { class: `${cls} ic-${k}`, viewBox: "-20.5 -20.5 41 41", role: "img", "aria-label": label, "data-mark": "status" };
  if (k === "ok") return svg("svg", base, [svg("circle", { class: "halo", r: "20.5" }), svg("circle", { class: "disc", r: "19.9" }), svg("polyline", { class: "glyph", points: "-7.5,1.8 -3,6 7.8,-5.6" })]);
  if (k === "warn" || k === "pending") return svg("svg", base, [svg("circle", { class: "halo", r: "20.5" }), svg("circle", { class: "disc", r: "19.9" }), svg("line", { class: "glyph", x1: "0", y1: "-9.6", x2: "0", y2: "1.8" }), svg("circle", { class: "dot", cx: "0", cy: "8.6", r: "2.2" })]);
  if (k === "todo") return svg("svg", base, [svg("circle", { class: "todo-ring", r: "17.5" })]);
  if (k === "doc") return svg("svg", base, [svg("circle", { class: "disc", r: "20" }), svg("path", { class: "line-glyph", d: "M-6 -10 H3 L8 -5 V10 H-6 Z M3 -10 V-5 H8 M-2 -1 H4 M-2 3.5 H4" })]);
  if (k === "calendar") return svg("svg", base, [svg("circle", { class: "disc", r: "20" }), svg("path", { class: "line-glyph", d: "M-9 -6 H9 V9 H-9 Z M-9 -1.5 H9 M-4.5 -9.5 V-4 M4.5 -9.5 V-4" })]);
  return svg("svg", base, [svg("circle", { class: "disc", r: "19.9" }), svg("circle", { class: "dot", r: "3" })]);
}
function star(): SVGElement {
  return svg("svg", { class: "star", viewBox: "0 0 24 24", "aria-hidden": "true", "data-mark": "icon" }, [svg("path", { d: "M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" })]);
}
function brand(): HTMLElement {
  const b = el("div", { class: "brand" });
  b.append(svg("svg", { class: "brand-mark", viewBox: "0 0 48 48", fill: "none", stroke: "currentColor", "stroke-width": "3", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", "data-mark": "product" }, [
    svg("path", { d: "M24 4 L40 10 V23 C40 33 33 40.5 24 44 C15 40.5 8 33 8 23 V10 Z" }),
    svg("path", { d: "M16.5 24.5 L22 30 L32 18.5" }),
  ]));
  b.append(el("span", { class: "brand-label" }, "Proof Before Pay"));
  return b;
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
function button(a: Action, cls: string, id?: string): HTMLButtonElement {
  const b = el("button", { type: "button", class: cls, "data-message": a.message, ...(id ? { id } : {}) }, a.label);
  b.addEventListener("click", () => say(a.message, b));
  return b;
}

function head(card: Card): HTMLElement {
  const h = el("header", { class: "card-head" });
  const t = el("div", { class: "head-text" });
  t.append(el("h1", { id: "title" }, card.title));
  if (card.tag) t.append(el("span", { class: "tag", id: "tag" }, card.tag));
  if (card.subtitle) t.append(el("p", { class: "subtitle", id: "subtitle" }, card.subtitle));
  h.append(t, brand());
  return h;
}

/** Icon + text (+ source / detail / money) + optional action. */
function rowEl(r: Row): HTMLLIElement {
  const li = el("li", { class: "row", "data-state": r.state, "data-kind": r.kind ?? "" });
  li.append(icon(r.icon ?? r.state));
  const txt = el("div", { class: "txt" });
  txt.append(el("span", { class: "what" }, r.label));
  if (r.detail) txt.append(el("span", { class: "detail" }, r.detail));
  if (r.money) txt.append(el("span", { class: "money" }, r.money));
  if (r.source) txt.append(el("span", { class: "src" }, r.source));
  li.append(txt);
  if (r.action) li.append(button(r.action, "row-action"));
  return li;
}

function moreButton(more: { label: string; rows: Row[] }, list: HTMLElement, make: (r: Row) => HTMLElement): HTMLButtonElement {
  const b = el("button", { type: "button", class: "more", id: "more" }, more.label);
  b.addEventListener("click", () => { for (const r of more.rows) list.append(make(r)); b.remove(); fit(); });
  return b;
}

// ---------- per-view layouts ----------
function renderPayment(card: Card, art: HTMLElement): void {
  const wrap = el("div", { class: "panels", id: "panels" });
  for (const p of card.panels ?? []) {
    const sec = el("section", { class: "panel", id: `panel-${p.kind}`, "data-kind": p.kind, "data-state": p.state, "aria-label": p.label });
    sec.append(el("p", { class: "amt-label" }, p.label), el("p", { class: "amt" }, p.amount));
    if (p.breakdown?.length) {
      const dl = el("dl", { class: "breakdown", id: "breakdown" });
      for (const b of p.breakdown) {
        const d = el("div", { class: "line", "data-kind": b.kind });
        d.append(el("dt", {}, b.label), el("dd", {}, b.value));
        dl.append(d);
      }
      sec.append(dl);
    }
    const ul = el("ul", { class: "rows" });
    for (const r of p.rows ?? []) ul.append(rowEl(r));
    sec.append(ul);
    if (p.kind === "wait" && card.more) sec.append(moreButton(card.more, ul, rowEl));
    if (p.action) sec.append(button(p.action, "action final", "action"));
    if (p.note) sec.append(el("p", { class: "panel-note", id: "panel-note" }, p.note));
    wrap.append(sec);
  }
  art.append(wrap);
}

function proRow(r: Row): HTMLLIElement {
  const li = el("li", { class: "row pro", "data-state": r.state, "data-kind": r.kind ?? "" });
  li.append(icon(r.state === "ok" ? "ok" : "warn", "ic lead"));
  const who = el("div", { class: "who" });
  who.append(el("h2", { class: "name" }, r.label));
  if (r.meta) {
    const m = el("p", { class: "meta" });
    m.append(star(), el("span", { class: "rate" }, `${r.meta.rating} ${r.meta.reviews}`), el("span", { class: "sep" }, "·"), el("span", { class: "est" }, r.meta.estimate));
    who.append(m);
  }
  li.append(who, el("div", { class: "divider", "aria-hidden": "true" }));
  const v = el("div", { class: "verdict" });
  v.append(icon(r.state === "ok" ? "ok" : "warn"));
  const vt = el("div", { class: "verdict-text" });
  vt.append(el("p", { class: "status-word" }, r.status ?? ""), el("p", { class: "license" }, r.detail ?? ""));
  v.append(vt);
  li.append(v);
  if (r.action) li.append(button(r.action, "row-action"));
  return li;
}
function renderPros(card: Card, art: HTMLElement): void {
  const ul = el("ul", { class: "rows", id: "rows" });
  for (const r of card.rows) ul.append(proRow(r));
  art.append(ul);
}

function statusRow(r: Row): HTMLLIElement {
  const li = el("li", { class: "row", "data-state": r.state, "data-kind": r.kind ?? "" });
  li.append(icon(r.icon ?? r.state));
  const t = el("div", { class: "txt" });
  t.append(el("p", { class: "row-title" }, r.label));
  if (r.detail) t.append(el("p", { class: "row-sub" }, r.detail));
  li.append(t);
  if (r.money) li.append(el("p", { class: "row-amt" }, r.money));
  return li;
}
function renderStatus(card: Card, art: HTMLElement): void {
  if (card.panels?.length) {
    const tiles = el("div", { class: "tiles", id: "tiles" });
    for (const p of card.panels) {
      const t = el("div", { class: "tile", "data-kind": p.kind, "data-state": p.state });
      t.append(icon(p.state === "ok" ? "ok" : "pending"));
      const tx = el("div", { class: "tile-text" });
      tx.append(el("p", { class: "tile-label" }, p.label), el("p", { class: "tile-amt" }, p.amount));
      t.append(tx);
      tiles.append(t);
    }
    art.append(tiles);
  }
  if (card.rows.length) {
    const list = el("div", { class: "list" });
    const ul = el("ul", { class: "rows", id: "rows" });
    for (const r of card.rows) ul.append(statusRow(r));
    list.append(ul);
    art.append(list);
  }
}

function scopeItem(r: Row): HTMLLIElement {
  const li = el("li", { class: "item", "data-state": r.state, "data-kind": r.kind ?? "item" });
  li.append(icon(r.icon ?? "todo"));
  const t = el("div", { class: "item-text" });
  t.append(el("p", { class: "item-name" }, r.label));
  if (r.detail) t.append(el("p", { class: "item-proof" }, r.detail));
  li.append(t);
  if (r.money) li.append(el("p", { class: "item-price" }, r.money));
  return li;
}
function renderSections(card: Card, art: HTMLElement): void {
  const body = el("div", { class: "sections", id: "sections" });
  for (const s of card.sections ?? []) {
    const sec = el("section", { class: `section section-${s.kind}`, "data-kind": s.kind });
    if (s.heading) sec.append(el("h2", { class: "section-heading" }, s.heading));
    const items = s.kind === "items";
    const ul = el("ul", { class: items ? "items" : "rows", ...(items ? { id: "items" } : {}) });
    for (const r of s.rows) ul.append(items ? scopeItem(r) : rowEl(r));
    sec.append(ul);
    if (s.more) sec.append(moreButton(s.more, ul, scopeItem));
    if (s.total) sec.append(el("p", { class: "total", id: "total" }, s.total));
    if (s.action) sec.append(button(s.action, s.action.style === "text" ? "action text" : "action", "action"));
    if (s.note) sec.append(el("p", { class: "section-note", "data-kind": s.note.kind }, s.note.text));
    body.append(sec);
  }
  art.append(body);
}

function renderWarranty(card: Card, art: HTMLElement): void {
  const ul = el("ul", { class: "rows big", id: "rows" });
  for (const r of card.rows) {
    const li = rowEl({ ...r, action: undefined });
    if (r.action) li.append(button(r.action, "row-action final", "action"));
    ul.append(li);
  }
  art.append(ul);
}

function renderGeneric(card: Card, art: HTMLElement): void {
  if (card.rows.length) {
    const ul = el("ul", { class: "rows", id: "rows" });
    for (const r of card.rows) ul.append(rowEl(r));
    art.append(ul);
    if (card.more) art.append(moreButton(card.more, ul, rowEl));
  }
  if (card.fields?.length) {
    const dl = el("dl", { class: "fields", id: "fields" });
    for (const f of card.fields) {
      const d = el("div", { class: "field", "data-kind": f.kind ?? "" });
      d.append(el("dt", {}, f.label));
      const dd = el("dd", {}, f.value);
      if (f.source) dd.append(el("span", { class: "src" }, ` · ${f.source}`));
      d.append(dd);
      dl.append(d);
    }
    art.append(dl);
  }
  if (card.note) art.append(el("pre", { class: "note", id: "note" }, card.note));
}

function render(card: Card): void {
  const art = el("article", { class: "card", id: "card", "data-view": card.view, "data-layout": card.layout });
  art.append(head(card));
  if (card.view === "payment" && card.panels) renderPayment(card, art);
  else if (card.view === "pros") renderPros(card, art);
  else if (card.view === "status") renderStatus(card, art);
  else if (card.sections?.length) renderSections(card, art);
  else if (card.view === "warranty") renderWarranty(card, art);
  else renderGeneric(card, art);
  const inPanel = card.view === "payment" && card.panels?.some((p) => p.action);
  const inSection = !!card.sections?.some((s) => s.action);
  const inRow = card.view === "warranty";
  if (card.action && !inPanel && !inSection && !inRow) art.append(button(card.action, card.action.style === "text" ? "action text" : "action", "action"));
  if (card.footer) art.append(el("p", { class: "footer", id: "footer" }, card.footer));
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
  const rootEl = document.documentElement;
  let zoom = deviceZoom;
  for (let i = 0; i < 4; i++) {
    rootEl.style.setProperty("zoom", String(zoom));
    if (!Number.isFinite(maxHeight)) break;
    const onScreen = (document.body.scrollHeight + 6) * zoom;
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
  // Web fonts can arrive after the first layout: fit again once they are in.
  document.fonts?.ready.then(() => { fit(); document.body.dataset.fonts = document.fonts.check(`16px Inter`) ? "inter" : "fallback"; });
};
app.onhostcontextchanged = (ctx) => applyHostContext(ctx as Record<string, unknown>);
app.ontoolcancelled = (p) => { root.replaceChildren(el("p", { class: "subtitle" }, `Cancelled: ${p.reason ?? "unknown"}`)); };
app.onerror = (e) => { console.error("[view]", e); };
app.connect().then(() => {
  applyHostContext(app.getHostContext() as Record<string, unknown> | undefined);
  document.body.dataset.connected = "1";
});
