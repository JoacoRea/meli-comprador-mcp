#!/usr/bin/env node
// Thin shim — adds the shebang npm bin entries need (tsc strips them).
// All substantive logic lives in src/cli.ts → dist/cli.js so it's
// type-checked.
//
// config.env is loaded BEFORE importing cli.js because some modules read
// env vars at import time (e.g. SCRAPE_LIMIT in buyer-actions).
import { loadEnvFile, defaultConfigEnvPath } from "../dist/env-file.js";

const loaded = loadEnvFile();
if (loaded.length > 0) {
  // stderr only (stdout is the stdio JSON-RPC channel); names, never values.
  console.error(
    JSON.stringify({ level: "info", msg: "meli_config_env_loaded", file: defaultConfigEnvPath(), vars: loaded })
  );
}

const { main } = await import("../dist/cli.js");
await main();
