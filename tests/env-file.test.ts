import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile, parseEnvFile } from "../src/env-file.js";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE, skips comments/blank lines and strips quotes", () => {
    expect(
      parseEnvFile('# comment\n\nA=1\r\nB = "two words"\nC=\'x=y\'\nbad line\n=nokey\nD=\n')
    ).toEqual({ A: "1", B: "two words", C: "x=y", D: "" });
  });
});

describe("loadEnvFile", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  it("fills only unset variables and returns their names", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "meli-env-"));
    const file = path.join(dir, "config.env");
    await fs.writeFile(file, "APIFY_TOKEN=from-file\nMELI_CLIENT_ID=file-id\nEMPTY_IN_ENV=filled\n");
    const env: NodeJS.ProcessEnv = { MELI_CLIENT_ID: "from-process", EMPTY_IN_ENV: "" };

    expect(loadEnvFile(file, env).sort()).toEqual(["APIFY_TOKEN", "EMPTY_IN_ENV"]);
    expect(env).toEqual({ APIFY_TOKEN: "from-file", MELI_CLIENT_ID: "from-process", EMPTY_IN_ENV: "filled" });
  });

  it("is a no-op when the file does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadEnvFile(path.join(os.tmpdir(), "does-not-exist-meli.env"), env)).toEqual([]);
    expect(env).toEqual({});
  });
});
