// Recorded DBPR result pages for the fictional demo pros (offline `npm run demo`, REGISTRY_MODE=fixture|auto).
// "found" pages are a real DBPR results page with every name, address, number and id replaced by fictional
// values; the "not found" page is a real empty results page. No real person or business appears in them.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RegistryFixture {
  /** Path relative to the app root, shown as the source ref, e.g. "fixtures/registry/dbpr-found.sample.html". */
  file: string;
  html: string;
}
export type RegistryFixtures = Readonly<Record<string, RegistryFixture>>;

export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** License number -> fixture file (relative to the app root). */
export const REGISTRY_FIXTURE_FILES: Readonly<Record<string, string>> = {
  EC99000101: "fixtures/registry/dbpr-found.sample.html", // BRIGHT CURRENT ELECTRIC, LLC (P1)
  EC99000102: "fixtures/registry/dbpr-found-2.sample.html", // HARBOR LINE ELECTRICAL INC (P2)
  EC99000103: "fixtures/registry/dbpr-not-found.sample.html", // empty result (P3, Quick Volt Pros)
};

export function loadRegistryFixtures(root: string = APP_ROOT, files: Readonly<Record<string, string>> = REGISTRY_FIXTURE_FILES): RegistryFixtures {
  const out: Record<string, RegistryFixture> = {};
  for (const [number, file] of Object.entries(files)) {
    out[number] = { file, html: readFileSync(join(root, file), "latin1") };
  }
  return out;
}
