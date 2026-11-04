import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildCatalog } from "../tests/measure/catalog.ts";

// Build the deterministic A13 measurement library once, for iterating on
// `mise run measure` with BORGES_MEASURE_CATALOG=<root> (the suite copies it
// and never uses it in place). Recorded measurements should seed fresh.
const target = process.argv[2];
if (!target)
  throw new Error(
    "usage: node scripts/build-measure-catalog.ts <new library root>",
  );
const root = resolve(target);
if (existsSync(root))
  throw new Error(`${root} already exists; choose a new path.`);
const ms = await buildCatalog(root);
console.log(
  `Built the 500-entry measurement library at ${root} in ${Math.round(ms / 1000)} s.`,
);
