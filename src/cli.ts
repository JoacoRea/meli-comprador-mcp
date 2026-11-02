/**
 * Entry-point logic for @kolmena-ai/meli-mcp.
 *
 * Invoked by bin/mcp-server.mjs (which is a 3-line shim that adds the
 * `#!/usr/bin/env node` shebang; tsc strips shebangs, so it has to live
 * in a hand-written JS file). All substantive logic lives here so it's
 * type-checked.
 *
 * Two transports, selected by a single CLI flag:
 *
 *   stdio (default) — Claude Desktop, Cursor, Windsurf, MCP Inspector, npx
 *     node bin/mcp-server.mjs
 *
 *   http — Bifrost / self-hosted Streamable HTTP. Serves POST /meli/mcp on
 *     $PORT (default 8000). Each request's `Authorization: Bearer <token>`
 *     header reaches tool callbacks via MCP `requestInfo` and is scoped per
 *     request through AsyncLocalStorage in MercadoLibreClient (see
 *     client.ts:runWithRequestAccessToken).
 *     node bin/mcp-server.mjs --transport http
 *
 * The Docker image bakes `--transport http` into its ENTRYPOINT; the npm
 * binary symlinks (`mercadolibre-mcp`, `meli-mcp`) invoke this script
 * without the flag, defaulting to stdio for Claude Desktop / npx use.
 *
 * Token resolution inside a tool call:
 *   1. `Authorization: Bearer <token>` from the inbound request (HTTP only)
 *   2. the auto-refreshing token store written by `pnpm auth`
 *      (see token-manager.ts; renewed with MELI_CLIENT_ID / MELI_CLIENT_SECRET)
 *   3. fallback to MERCADOLIBRE_ACCESS_TOKEN env var (static, never renewed)
 *   4. else no Authorization header is sent — calls that require auth 403.
 */
import http from "node:http";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AccessTokenProvider } from "./client.js";
import { createMcpServer } from "./mcp-server.js";
import { tokenManagerFromEnv } from "./token-manager.js";

// Bifrost has this path baked into its MCP client config.
const HTTP_PATH = "/meli/mcp";

export async function main(): Promise<void> {
  // stderr, not stdout — the stdio transport reserves stdout for JSON-RPC.
  const auth = tokenManagerFromEnv(process.env, (line) => console.error(line));

  const { values: cliArgs } = parseArgs({
    options: { transport: { type: "string", default: "stdio" } },
    strict: false, // tolerate unknown args (e.g., when invoked under npx wrappers)
  });
  const transportKind = cliArgs.transport;

  if (transportKind === "stdio") {
    const server = createMcpServer(auth);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  if (transportKind === "http") {
    await runHttp(auth);
    return;
  }

  console.error(`Unknown transport: ${String(transportKind)}. Use --transport stdio|http.`);
  process.exit(1);
}

async function runHttp(auth: AccessTokenProvider): Promise<void> {
  const port = Number(process.env.PORT ?? 8000);

  const httpServer = http.createServer(async (req, res) => {
    const start = process.hrtime.bigint();
    const method = req.method ?? "GET";
    const url = req.url ?? "";

    // Always log the request outcome. This fires regardless of whether
    // we wrote the response ourselves or the SDK / hono request listener
    // wrote it for us — so it catches the case where hono's getRequestListener
    // catches an internal exception and writes its own 500 before our
    // try/catch can see the throw.
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const status = res.statusCode;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
      console.error(
        JSON.stringify({
          level,
          msg: "http_request",
          method,
          url,
          status,
          duration_ms: Math.round(durationMs),
        })
      );
    });

    if (method === "GET" && url === "/healthz") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("ok");
      return;
    }

    if (url === HTTP_PATH) {
      // Per-request McpServer + transport. The SDK's
      // StreamableHTTPServerTransport keeps `_initialized` and a few
      // bookkeeping maps on instance state; sharing one transport
      // across requests corrupts that state on the second request and
      // causes the SDK to throw synchronously inside hono's
      // getRequestListener, which then writes a default 500 text/plain
      // empty body that our outer try/catch never sees. Constructing a
      // fresh pair per request is the canonical stateless pattern.
      const server = createMcpServer(auth);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      transport.onerror = (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error(
          JSON.stringify({
            level: "error",
            msg: "mcp_transport_error",
            method,
            url,
            error: message,
            stack,
          })
        );
      };
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        // Captures throws that reach our caller — complements the
        // transport.onerror callback above which captures throws hono
        // swallows internally.
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error(
          JSON.stringify({
            level: "error",
            msg: "mcp_handle_request_threw",
            method,
            url,
            error: message,
            stack,
          })
        );
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: message }));
        }
      }
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  httpServer.listen(port, () => {
    console.log(`mercadolibre-mcp listening on :${port}${HTTP_PATH} (streamable-http)`);
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`received ${signal}, draining`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
