// MCP App View for ui://notes/card.html. Bundled by build.ts and inlined into dist/card.html.
// Uses the official App class (ext-apps) to talk to the host's AppBridge over postMessage.
import { App } from "@modelcontextprotocol/ext-apps";

type NotesPayload = { user_id?: string; notes?: string[] };

const list = document.getElementById("notes") as HTMLUListElement;
const title = document.getElementById("title") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;

function render(payload: NotesPayload): void {
  title.textContent = payload.user_id ? `Notes for ${payload.user_id}` : "Notes";
  list.replaceChildren();
  const notes = payload.notes ?? [];
  if (!notes.length) {
    const li = document.createElement("li");
    li.textContent = "No notes yet.";
    list.append(li);
  }
  for (const text of notes) {
    const li = document.createElement("li");
    li.textContent = text; // textContent, never innerHTML: notes are user input
    list.append(li);
  }
}

const app = new App({ name: "notes-card", version: "0.0.1" });

app.ontoolresult = async (result) => {
  const payload = (result.structuredContent ?? {}) as NotesPayload;
  render(payload);
  // Prove the View -> host -> MCP server path: call a server tool from inside the sandbox.
  if (!payload.user_id) return;
  try {
    const recall = await app.callServerTool({ name: "recall", arguments: { user_id: payload.user_id } });
    const n = ((recall.structuredContent ?? {}) as NotesPayload).notes?.length ?? 0;
    status.textContent = `View->server roundtrip OK: recall returned ${n} note(s)`;
    status.dataset.roundtrip = "ok";
  } catch (err) {
    status.textContent = `View->server roundtrip FAILED: ${String(err)}`;
    status.dataset.roundtrip = "failed";
  }
};
app.ontoolcancelled = (p) => { status.textContent = `Cancelled: ${p.reason ?? "unknown"}`; };
app.onerror = (e) => { console.error("[view]", e); };

app.connect().then(() => { status.textContent = "Connected to host, waiting for tool result..."; });
