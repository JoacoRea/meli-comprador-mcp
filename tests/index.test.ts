import { describe, it, expect, vi } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createMercadoLibreTools", () => {
  it("exposes only the read-only buyer tools", async () => {
    const { createMercadoLibreTools, BUYER_READONLY_TOOLS } = await import("../src/index.js");
    const { tools } = createMercadoLibreTools();

    expect(Object.keys(tools).sort()).toEqual([...BUYER_READONLY_TOOLS].sort());
    for (const fn of Object.values(tools)) expect(typeof fn).toBe("function");
  });

  it("tools call the API correctly", async () => {
    const { createMercadoLibreTools } = await import("../src/index.js");
    const { tools } = createMercadoLibreTools("TEST_TOKEN");

    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [], paging: { total: 0, limit: 10, offset: 0 } }));
    await tools.search_items({ query: "test" });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/products/search"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer TEST_TOKEN" }),
      })
    );

    mockFetch.mockResolvedValueOnce(jsonResponse({ plain_text: "desc" }));
    await tools.get_item_description({ item_id: "MLA1" });

    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 1 }));
    await tools.get_seller_info({ seller_id: 1 });

  });
});
