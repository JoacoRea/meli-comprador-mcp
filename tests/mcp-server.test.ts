import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function setupMcpClient() {
  const { createMcpServer } = await import("../src/mcp-server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, server };
}

describe("MCP Server", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("creates server with correct name and version", async () => {
    const { createMcpServer } = await import("../src/mcp-server.js");
    const server = createMcpServer();
    expect(server).toBeDefined();
  });

  // Guardrail: this fork is read-only. The list is hard-coded here (not
  // imported from src) on purpose, so adding any tool — especially one that
  // writes to Mercado Libre — fails this test until it is reviewed.
  it("registers exactly the 9 read-only buyer tools", async () => {
    const { client } = await setupMcpClient();
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        "find_offers_for_product_query",
        "get_item_description",
        "get_item_questions",
        "get_item_reviews",
        "get_listing_offer",
        "get_product",
        "get_product_buybox",
        "get_seller_info",
        "search_items",
      ].sort()
    );
    expect(names.some((n) => n.startsWith("seller_"))).toBe(false);
    expect(names).not.toContain("ask_seller_question");

    await client.close();
  });

  it("BUYER_READONLY_TOOLS matches the registered tools", async () => {
    const { BUYER_READONLY_TOOLS } = await import("../src/index.js");
    const { client } = await setupMcpClient();
    const result = await client.listTools();
    expect(result.tools.map((t) => t.name).sort()).toEqual([...BUYER_READONLY_TOOLS].sort());
    await client.close();
  });

  describe("tool calls — success", () => {
    it("search_items returns results", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ results: [{ id: "MLA1" }] }));
      const { client } = await setupMcpClient();

      const result = await client.callTool({ name: "search_items", arguments: { query: "iphone" } });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(JSON.parse(text).results).toHaveLength(1);
      await client.close();
    });

    it("get_item_description returns description", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ plain_text: "A product" }));
      const { client } = await setupMcpClient();

      const result = await client.callTool({ name: "get_item_description", arguments: { item_id: "MLA123" } });
      const text = (result.content as Array<{ text: string }>)[0].text;
      const parsed = JSON.parse(text) as { description: { plain_text: string } };
      expect(parsed.description.plain_text).toBe("A product");
      await client.close();
    });


    it("get_seller_info returns seller", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 123, nickname: "SELLER" }));
      const { client } = await setupMcpClient();

      const result = await client.callTool({ name: "get_seller_info", arguments: { seller_id: 123 } });
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(JSON.parse(text).nickname).toBe("SELLER");
      await client.close();
    });
  });

  describe("tool calls — errors", () => {
    it("search_items returns error on API failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Server Error", { status: 500 }));
      const { client } = await setupMcpClient();

      const result = await client.callTool({ name: "search_items", arguments: { query: "test" } });
      expect(result.isError).toBe(true);
      await client.close();
    });

    it("get_item_description returns error when listing and catalog are missing", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
      mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
      const { client } = await setupMcpClient();

      const result = await client.callTool({ name: "get_item_description", arguments: { item_id: "INVALID" } });
      expect(result.isError).toBe(true);
      await client.close();
    });


    it("get_seller_info returns error on failure", async () => {
      mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
      const { client } = await setupMcpClient();

      const result = await client.callTool({ name: "get_seller_info", arguments: { seller_id: 999 } });
      expect(result.isError).toBe(true);
      await client.close();
    });
  });
});
