import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AccessTokenProvider } from "./client.js";
import { createMercadoLibreTools } from "./index.js";
import { registerMercadoLibreTools } from "./mcp-tools.js";

export function createMcpServer(auth?: string | AccessTokenProvider) {
  const { tools } = createMercadoLibreTools(auth);

  const server = new McpServer({
    name: "meli-comprador-mcp",
    version: "2.0.0",
  });

  registerMercadoLibreTools(server, tools);

  return server;
}
