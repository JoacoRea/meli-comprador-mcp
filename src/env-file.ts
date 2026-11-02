/**
 * Loads `KEY=VALUE` lines from a local config file into the environment,
 * without overriding variables that are already set.
 *
 * Why: MCP hosts don't always pass the user's environment to the server
 * (e.g. launchers that start Claude Desktop with a stale environment), so
 * MELI_CLIENT_ID / MELI_CLIENT_SECRET / APIFY_TOKEN can live next to the
 * token store instead. Default path: ~/.config/meli-comprador-mcp/config.env
 * (override with MELI_CONFIG_FILE).
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultConfigEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.MELI_CONFIG_FILE ||
    path.join(os.homedir(), ".config", "meli-comprador-mcp", "config.env")
  );
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) out[key] = value;
  }
  return out;
}

/** Returns the names (never values) of the variables it filled in. */
export function loadEnvFile(
  filePath: string = defaultConfigEnvPath(),
  env: NodeJS.ProcessEnv = process.env
): string[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseEnvFile(text))) {
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}
