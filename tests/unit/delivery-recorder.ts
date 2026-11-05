import { writeFileSync } from "node:fs";

writeFileSync(
  process.env.DELIVERY_RECORD as string,
  JSON.stringify({
    args: process.argv.slice(2),
    root: process.env.BORGES_LIBRARY_ROOT,
    overrides: Object.fromEntries(
      [
        "ELECTRON_RUN_AS_NODE",
        "NODE_OPTIONS",
        "NODE_PATH",
        "ELECTRON_RENDERER_URL",
        "BORGES_DEV_PROFILE",
      ].flatMap((name) =>
        process.env[name] === undefined ? [] : [[name, process.env[name]]],
      ),
    ),
  }),
);
