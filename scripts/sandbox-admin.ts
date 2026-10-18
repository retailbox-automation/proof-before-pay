// Operator control of one account's demo state, run INSIDE the hosted container (the public gateway refuses the
// echo-* accounts, so this is the only way to drive the Echo Show demo's clock):
//   node scripts/sandbox-admin.ts reset   [account]   sandbox tenant back to the start + the add-on's saved state deleted
//   node scripts/sandbox-admin.ts demo    [account]   clock -> Thu Oct 15, 2:15 PM (visit done, invoice and photos posted)
//   node scripts/sandbox-admin.ts warranty [account]  clock -> Thu Nov 12, 9:00 AM (four weeks later)
//   node scripts/sandbox-admin.ts clock   [account]   show the tenant's clock
// account defaults to echo-demo (the Alexa skill's account). From a laptop:
//   zeabur service exec --id <service> --env-id <env> -- node scripts/sandbox-admin.ts reset
import { rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../server/store.ts";

const [cmd = "clock", account = "echo-demo"] = process.argv.slice(2);
if (!/^[A-Za-z0-9_.-]{1,64}$/.test(account)) throw new Error("bad account id");
const base = `${process.env.SANDBOX_BASE ?? "http://127.0.0.1:18791"}/t/${account}/sim`;
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json() as { nowLocal?: string; emitted?: unknown[]; error?: { message: string } };
  if (!r.ok) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  return j;
};

if (cmd === "reset") {
  const file = join(dataDir(), "users", `${account}.json`);
  rmSync(file, { force: true });
  const c = await post("/reset", { scenario: "demo" });
  console.log(`reset ${account}: saved add-on state removed (${file}), sandbox clock ${c.nowLocal}`);
} else if (cmd === "demo" || cmd === "warranty") {
  const c = await post("/advance", { to: cmd });
  console.log(`${account}: clock ${c.nowLocal}, ${c.emitted?.length ?? 0} camera webhook(s)`);
} else if (cmd === "clock") {
  const r = await fetch(`${base}/clock`);
  const c = await r.json() as { nowLocal: string; bookings: unknown[] };
  console.log(`${account}: clock ${c.nowLocal}, bookings ${JSON.stringify(c.bookings)}`);
} else {
  console.error("usage: node scripts/sandbox-admin.ts reset|demo|warranty|clock [account]");
  process.exit(2);
}
