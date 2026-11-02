import { describe, it, expect, vi, beforeEach } from "vitest";
import { MercadoLibreClient } from "../src/client.js";
import {
  getProductBuybox,
  getItemReviews,
  findOffersForProductQuery,
  rankSellersForQuery,
  getMyOrders,
  searchMyClaims,
} from "../src/buyer-actions.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("buyer-actions", () => {
  let client: MercadoLibreClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new MercadoLibreClient("TOKEN");
  });

  describe("getProductBuybox", () => {
    it("extracts buy box item id from product", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: "MLA55016525",
          name: "iPhone",
          buy_box_winner: { item_id: "MLA903218023" },
          buy_box_winner_price_range: { min: 100, max: 120 },
        })
      );

      const result = await getProductBuybox(client, { product_id: "MLA55016525" });
      expect(result).toMatchObject({
        product_id: "MLA55016525",
        buy_box_winner_item_id: "MLA903218023",
      });
    });
  });

  describe("getItemReviews", () => {
    it("fetches reviews with optional catalog_product_id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ rating_average: 4.8, reviews: [] }));

      await getItemReviews(client, {
        item_id: "MLA123",
        catalog_product_id: "MLA999",
      });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/reviews/item/MLA123");
      expect(url).toContain("catalog_product_id=MLA999");
    });
  });

  describe("findOffersForProductQuery", () => {
    it("returns catalog_without_price when buy box is missing", async () => {
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse({
            results: [{ id: "MLA26385767", name: "MacBook Air" }],
            paging: { total: 1, limit: 10, offset: 0 },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            id: "MLA26385767",
            name: "MacBook Air",
            buy_box_winner: null,
            permalink: "https://www.mercadolibre.com.ar/macbook-air",
          })
        );

      const result = await findOffersForProductQuery(client, {
        query: "MacBook Air",
      });

      expect(result).toMatchObject({
        strategy: "product_query_catalog_then_buy_box",
        offer_count: 0,
        catalog_without_price_count: 1,
        catalog_without_price: [
          expect.objectContaining({
            catalog_product_id: "MLA26385767",
            permalink: "https://www.mercadolibre.com.ar/macbook-air",
          }),
        ],
      });
    });

    it("returns offers when buy box exists", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ results: [{ id: "MLA55016525", name: "Phone" }] }))
        .mockResolvedValueOnce(jsonResponse({ id: "MLA55016525", buy_box_winner: "MLA903218023" }))
        .mockResolvedValueOnce(
          jsonResponse({
            id: "MLA903218023",
            title: "Phone listing",
            price: 50000,
            seller_id: 111,
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            id: 111,
            nickname: "seller1",
            seller_reputation: { level_id: "5_green" },
          })
        );

      const result = await findOffersForProductQuery(client, { query: "iphone" });

      expect(result).toMatchObject({
        offer_count: 1,
        offers: [
          expect.objectContaining({
            listing_id: "MLA903218023",
            price: 50000,
            seller: expect.objectContaining({ nickname: "seller1" }),
          }),
        ],
      });
    });
  });

  describe("rankSellersForQuery", () => {
    it("ranks sellers via domain discovery and seller inventory", async () => {
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse([
            {
              domain_id: "MLA-NOTEBOOKS",
              category_id: "MLA1652",
              category_name: "Notebooks",
            },
          ])
        )
        .mockResolvedValueOnce(
          jsonResponse({
            results: [{ id: "MLA100", name: "MacBook Air" }],
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            id: "MLA100",
            buy_box_winner: { item_id: "MLA-L1" },
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            id: "MLA-L1",
            title: "MacBook Air M2",
            price: 1000000,
            currency_id: "ARS",
            seller_id: 111,
            permalink: "https://example.com/1",
          })
        )
        .mockResolvedValueOnce(jsonResponse({ results: [] }))
        .mockResolvedValueOnce(
          jsonResponse({
            id: 111,
            nickname: "seller_green",
            seller_reputation: { level_id: "5_green" },
          })
        )
        .mockResolvedValueOnce(jsonResponse({ results: ["MLA-L1", "MLA-L9"] }))
        .mockResolvedValueOnce(
          jsonResponse([
            { id: "MLA-L1", title: "MacBook Air M2", price: 1000000, currency_id: "ARS" },
            { id: "MLA-L9", title: "Other phone", price: 50000, currency_id: "ARS" },
          ])
        );

      const result = await rankSellersForQuery(client, {
        query: "MacBook Air",
        top_sellers: 1,
      });

      expect(result).toMatchObject({
        strategy: "domain_catalog_category_sellers",
        domain_id: "MLA-NOTEBOOKS",
        category_id: "MLA1652",
        unique_sellers_found: 1,
        top_sellers: [
          expect.objectContaining({
            seller_id: 111,
            listing_count: 1,
            listings: [
              expect.objectContaining({
                listing_id: "MLA-L1",
                title: "MacBook Air M2",
              }),
            ],
          }),
        ],
      });
    });
  });

  describe("getMyOrders", () => {
    it("resolves buyer from /users/me when omitted", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ id: 89660613 }))
        .mockResolvedValueOnce(jsonResponse({ results: [] }));

      await getMyOrders(client, {});

      const ordersUrl = mockFetch.mock.calls[1][0] as string;
      expect(ordersUrl).toContain("buyer=89660613");
    });
  });

  describe("searchMyClaims", () => {
    it("calls post-purchase claims search", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

      await searchMyClaims(client, { status: "opened" });

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/post-purchase/v1/claims/search");
      expect(url).toContain("status=opened");
    });
  });
});
