import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ApifyScraper,
  siteToCountry,
  type ScrapedOffer,
  type ScrapedSearchResult,
  type ScrapedSeller,
  type ScrapedReview,
  type ScraperProvider,
} from "../src/apify-scraper.js";
import { MercadoLibreClient } from "../src/client.js";
import {
  findOffersForProductQuery,
  getProductBuybox,
  getListingOffer,
  getItemReviews,
  rankSellersForQuery,
} from "../src/buyer-actions.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PRODUCT_ROW = {
  title: "Apple iPhone 15 (128 GB) - Azul",
  price: 1265000,
  currency: "ARS",
  condition: "NewCondition",
  availableQuantity: 1,
  installments: { quantity: 6, amount: 284603.92 },
  freeShipping: true,
  sellerId: 12345,
  sellerName: "FDATECNO",
  isOfficialStore: false,
  url: "https://www.mercadolibre.com.ar/p/MLA27172667",
  canonicalUrl: "https://www.mercadolibre.com.ar/apple-iphone-15-128-gb-azul/p/MLA27172667",
  scrapedAt: "2026-06-08T19:33:52.869Z",
};

describe("siteToCountry", () => {
  it("maps known sites and defaults to AR", () => {
    expect(siteToCountry("MLA")).toBe("AR");
    expect(siteToCountry("MLB")).toBe("BR");
    expect(siteToCountry("MLM")).toBe("MX");
    expect(siteToCountry(undefined)).toBe("AR");
    expect(siteToCountry("ZZZ")).toBe("AR");
  });
});

describe("ApifyScraper", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("is disabled and does not call the network without a token", async () => {
    const scraper = new ApifyScraper({} as NodeJS.ProcessEnv);
    expect(scraper.enabled).toBe(false);
    expect(await scraper.scrapeProduct("https://x")).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("normalizes a priced product row", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([PRODUCT_ROW]));
    const scraper = new ApifyScraper({ APIFY_TOKEN: "tok" } as NodeJS.ProcessEnv);
    const offer = await scraper.scrapeProduct("https://www.mercadolibre.com.ar/p/MLA27172667", {
      site_id: "MLA",
    });
    expect(offer).toMatchObject({
      price: 1265000,
      currency: "ARS",
      condition: "NewCondition",
      seller_name: "FDATECNO",
      seller_id: 12345,
      free_shipping: true,
    });
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("sourabhbgp~mercadolibre-scraper");
    expect(url).toContain("run-sync-get-dataset-items");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ mode: "product", country: "AR" });
  });

  it("returns null when the scraped row has no price", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([{ title: "no price", url: "u" }]));
    const scraper = new ApifyScraper({ APIFY_TOKEN: "tok" } as NodeJS.ProcessEnv);
    expect(await scraper.scrapeProduct("https://x")).toBeNull();
  });

  it("treats a zero price as no price", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([{ title: "zero", price: 0, currency: "ARS", url: "u" }]));
    const scraper = new ApifyScraper({ APIFY_TOKEN: "tok" } as NodeJS.ProcessEnv);
    expect(await scraper.scrapeProduct("https://x")).toBeNull();
  });

  it("fails soft on non-2xx", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "bad" }, 402));
    const scraper = new ApifyScraper({ APIFY_TOKEN: "tok" } as NodeJS.ProcessEnv);
    expect(await scraper.scrapeProduct("https://x")).toBeNull();
  });

  it("fails soft when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("timeout"));
    const scraper = new ApifyScraper({ APIFY_TOKEN: "tok" } as NodeJS.ProcessEnv);
    expect(await scraper.scrapeProduct("https://x")).toBeNull();
  });

  it("caches identical calls within the TTL", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse([PRODUCT_ROW]));
    const scraper = new ApifyScraper({ APIFY_TOKEN: "tok" } as NodeJS.ProcessEnv);
    const url = "https://www.mercadolibre.com.ar/p/MLA27172667";
    const a = await scraper.scrapeProduct(url, { site_id: "MLA" });
    const b = await scraper.scrapeProduct(url, { site_id: "MLA" });
    expect(a).toEqual(b);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("scrapeSearch drops price-less rows", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse([
        { title: "A", price: 100, currency: "ARS", sellerName: "s1", url: "u1" },
        { title: "B", url: "u2" },
      ])
    );
    const scraper = new ApifyScraper({ APIFY_TOKEN: "tok" } as NodeJS.ProcessEnv);
    const results = await scraper.scrapeSearch("iphone", { site_id: "MLA" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: "A", price: 100 });
  });
});

/** Minimal in-memory scraper used to drive the enrichment branches deterministically. */
class FakeScraper implements ScraperProvider {
  enabled = true;
  constructor(
    private readonly product: ScrapedOffer | null = null,
    private readonly search: ScrapedSearchResult[] = [],
    private readonly reviews: ScrapedReview[] = []
  ) {}
  async scrapeProduct(): Promise<ScrapedOffer | null> {
    return this.product;
  }
  async scrapeSearch(): Promise<ScrapedSearchResult[]> {
    return this.search;
  }
  async scrapeSeller(): Promise<ScrapedSeller | null> {
    return null;
  }
  async scrapeReviews(): Promise<ScrapedReview[]> {
    return this.reviews;
  }
}

const WEB_OFFER: ScrapedOffer = {
  price: 1265000,
  original_price: null,
  discount_percentage: null,
  currency: "ARS",
  condition: "NewCondition",
  availability: null,
  available_quantity: 1,
  sold_quantity: null,
  installments: null,
  free_shipping: true,
  shipping: null,
  rating: null,
  rating_count: null,
  seller_id: 12345,
  seller_name: "FDATECNO",
  seller_reputation: null,
  is_official_store: false,
  title: "Apple iPhone 15 (128 GB) - Azul",
  url: "https://www.mercadolibre.com.ar/p/MLA27172667",
  scraped_at: "2026-06-08T19:33:52.869Z",
};

const WEB_SEARCH_HIT: ScrapedSearchResult = {
  title: "Apple iPhone 15 (128 GB) - Azul",
  price: 1265000,
  original_price: null,
  currency: "ARS",
  condition: "NewCondition",
  free_shipping: true,
  rating: null,
  seller_name: null,
  catalog_product_id: "MLA27172667",
  url: "https://www.mercadolibre.com.ar/p/MLA27172667",
};

describe("enrichment wiring", () => {
  let client: MercadoLibreClient;

  beforeEach(() => {
    mockFetch.mockReset();
    client = new MercadoLibreClient("TOKEN");
  });

  it("findOffersForProductQuery sources web offers from website search and enriches seller via product detail", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: "MLA27172667", name: "iPhone 15 Azul" }] }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "MLA27172667",
          name: "iPhone 15 Azul",
          buy_box_winner: null,
          permalink: "https://www.mercadolibre.com.ar/p/MLA27172667",
        })
      );

    const result = (await findOffersForProductQuery(
      client,
      { query: "iphone 15 azul" },
      new FakeScraper(WEB_OFFER, [WEB_SEARCH_HIT])
    )) as {
      offer_count: number;
      web_enriched_count: number;
      catalog_without_price_count: number;
      offers: Array<Record<string, unknown>>;
    };

    expect(result.offer_count).toBe(1);
    expect(result.web_enriched_count).toBe(1);
    expect(result.catalog_without_price_count).toBe(0);
    expect(result.offers[0]).toMatchObject({
      price: 1265000,
      price_source: "web",
      catalog_product_id: "MLA27172667",
      permalink: "https://www.mercadolibre.com.ar/p/MLA27172667",
    });
    // seller layered in from the best-effort product-mode detail scrape
    expect((result.offers[0].seller as { nickname: string }).nickname).toBe("FDATECNO");
  });

  it("findOffersForProductQuery keeps the search hit's price+link when product detail fails", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: "MLA68039639", name: "Samsung B350E" }] }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "MLA68039639", name: "Samsung B350E", buy_box_winner: null, permalink: "" })
      );

    const hit: ScrapedSearchResult = {
      title: "Samsung B350E Dual SIM",
      price: 200000,
      original_price: null,
      currency: "ARS",
      condition: "NewCondition",
      free_shipping: false,
      rating: null,
      seller_name: null,
      catalog_product_id: "MLA68039639",
      url: "https://www.mercadolibre.com.ar/p/MLA68039639",
    };

    // product-mode detail returns null (slow/blocked) -> graceful degrade
    const result = (await findOffersForProductQuery(
      client,
      { query: "samsung b350e" },
      new FakeScraper(null, [hit])
    )) as { offer_count: number; web_enriched_count: number; offers: Array<Record<string, unknown>> };

    expect(result.offer_count).toBe(1);
    expect(result.web_enriched_count).toBe(1);
    expect(result.offers[0]).toMatchObject({
      price: 200000,
      price_source: "web",
      permalink: "https://www.mercadolibre.com.ar/p/MLA68039639",
      seller: null,
    });
  });

  it("findOffersForProductQuery leaves catalog_without_price when scrape_limit is 0", async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: "MLA27172667", name: "iPhone" }] }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "MLA27172667", buy_box_winner: null, permalink: "https://x/p/MLA27172667" })
      );

    const result = (await findOffersForProductQuery(
      client,
      { query: "iphone", scrape_limit: 0 },
      new FakeScraper(WEB_OFFER, [WEB_SEARCH_HIT])
    )) as { offer_count: number; web_enriched_count: number; catalog_without_price_count: number };

    expect(result.offer_count).toBe(0);
    expect(result.web_enriched_count).toBe(0);
    expect(result.catalog_without_price_count).toBe(1);
  });

  it("getProductBuybox returns web_offer when there is no buy box winner", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        id: "MLA27172667",
        name: "iPhone 15 Azul",
        buy_box_winner: null,
        permalink: "https://www.mercadolibre.com.ar/p/MLA27172667",
      })
    );

    const result = (await getProductBuybox(
      client,
      { product_id: "MLA27172667" },
      new FakeScraper(WEB_OFFER)
    )) as { price_source: string | null; web_offer: Record<string, unknown> | null };

    expect(result.price_source).toBe("web");
    expect(result.web_offer).toMatchObject({ price: 1265000, price_source: "web" });
  });

  it("getListingOffer scrapes a pasted listing id and returns a web offer", async () => {
    const result = (await getListingOffer(
      { listing: "MLA1804763057" },
      new FakeScraper(WEB_OFFER)
    )) as {
      item_id: string | null;
      price_source: string | null;
      offer: Record<string, unknown> | null;
    };

    expect(result.item_id).toBe("MLA1804763057");
    expect(result.price_source).toBe("web");
    expect(result.offer).toMatchObject({
      price: 1265000,
      price_source: "web",
      free_shipping: true,
      seller: expect.objectContaining({ nickname: "FDATECNO" }),
    });
  });

  it("getListingOffer builds an articulo listing URL from a bare id", async () => {
    let seenUrl: string | null = null;
    const capturing: ScraperProvider = {
      enabled: true,
      async scrapeProduct(url: string): Promise<ScrapedOffer | null> {
        seenUrl = url;
        return WEB_OFFER;
      },
      async scrapeSearch(): Promise<ScrapedSearchResult[]> {
        return [];
      },
      async scrapeSeller(): Promise<ScrapedSeller | null> {
        return null;
      },
      async scrapeReviews(): Promise<ScrapedReview[]> {
        return [];
      },
    };

    await getListingOffer({ listing: "MLA1804763057" }, capturing);
    expect(seenUrl).toBe("https://articulo.mercadolibre.com.ar/MLA-1804763057-_JM");
  });

  it("getListingOffer retries a bare id as a catalog product page when the listing page has no price", async () => {
    const seen: string[] = [];
    const scraper: ScraperProvider = {
      enabled: true,
      async scrapeProduct(url: string): Promise<ScrapedOffer | null> {
        seen.push(url);
        return url.includes("/p/") ? WEB_OFFER : null;
      },
      async scrapeSearch(): Promise<ScrapedSearchResult[]> {
        return [];
      },
      async scrapeSeller(): Promise<ScrapedSeller | null> {
        return null;
      },
      async scrapeReviews(): Promise<ScrapedReview[]> {
        return [];
      },
    };

    const result = (await getListingOffer({ listing: "MLA28305736" }, scraper)) as {
      resolved_as: string;
      item_id: string | null;
      catalog_product_id: string;
      offer: { price: number; item_id: string | null } | null;
    };

    expect(seen).toEqual([
      "https://articulo.mercadolibre.com.ar/MLA-28305736-_JM",
      "https://www.mercadolibre.com.ar/p/MLA28305736",
    ]);
    expect(result.resolved_as).toBe("catalog_product");
    expect(result.catalog_product_id).toBe("MLA28305736");
    expect(result.item_id).toBeNull();
    expect(result.offer).toMatchObject({ price: 1265000, item_id: null });
  });

  it("getListingOffer keeps both attempts inside the ~60s MCP call budget", async () => {
    let now = 0;
    const timeouts: Array<number | undefined> = [];
    const scraper: ScraperProvider = {
      enabled: true,
      async scrapeProduct(_url: string, opts?: { timeoutMs?: number }): Promise<ScrapedOffer | null> {
        timeouts.push(opts?.timeoutMs);
        // Simulate the attempt running until its timeout.
        now += opts?.timeoutMs ?? 0;
        return null;
      },
      async scrapeSearch(): Promise<ScrapedSearchResult[]> {
        return [];
      },
      async scrapeSeller(): Promise<ScrapedSeller | null> {
        return null;
      },
      async scrapeReviews(): Promise<ScrapedReview[]> {
        return [];
      },
    };

    const start = 1_000_000;
    now = start;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await getListingOffer({ listing: "MLA28305736" }, scraper);
    } finally {
      spy.mockRestore();
    }
    expect(timeouts).toEqual([25_000, 25_000]);
    expect(now - start).toBeLessThanOrEqual(50_000);
  });

  it("getListingOffer does not retry as catalog when a full URL was pasted", async () => {
    const seen: string[] = [];
    const scraper: ScraperProvider = {
      enabled: true,
      async scrapeProduct(url: string): Promise<ScrapedOffer | null> {
        seen.push(url);
        return null;
      },
      async scrapeSearch(): Promise<ScrapedSearchResult[]> {
        return [];
      },
      async scrapeSeller(): Promise<ScrapedSeller | null> {
        return null;
      },
      async scrapeReviews(): Promise<ScrapedReview[]> {
        return [];
      },
    };

    const result = (await getListingOffer(
      { listing: "https://articulo.mercadolibre.com.ar/MLA-1-x-_JM" },
      scraper
    )) as { offer: unknown };
    expect(seen).toHaveLength(1);
    expect(result.offer).toBeNull();
  });

  it("getListingOffer passes a full pasted URL straight to the scraper", async () => {
    let seenUrl: string | null = null;
    const pasted = "https://articulo.mercadolibre.com.ar/MLA-1804763057-algo-_JM";
    const capturing: ScraperProvider = {
      enabled: true,
      async scrapeProduct(url: string): Promise<ScrapedOffer | null> {
        seenUrl = url;
        return WEB_OFFER;
      },
      async scrapeSearch(): Promise<ScrapedSearchResult[]> {
        return [];
      },
      async scrapeSeller(): Promise<ScrapedSeller | null> {
        return null;
      },
      async scrapeReviews(): Promise<ScrapedReview[]> {
        return [];
      },
    };

    await getListingOffer({ listing: pasted }, capturing);
    expect(seenUrl).toBe(pasted);
  });

  it("getListingOffer returns offer:null with a note when no scraper is configured", async () => {
    const result = (await getListingOffer({ listing: "MLA1804763057" }, undefined)) as {
      offer: unknown;
      price_source: string | null;
      note: string;
    };
    expect(result.offer).toBeNull();
    expect(result.price_source).toBeNull();
    expect(result.note).toContain("not configured");
  });

  it("getListingOffer returns offer:null when the input is not a resolvable listing", async () => {
    const result = (await getListingOffer(
      { listing: "not-a-listing" },
      new FakeScraper(WEB_OFFER)
    )) as { offer: unknown; item_id: string | null; note: string };
    expect(result.offer).toBeNull();
    expect(result.item_id).toBeNull();
    expect(result.note).toContain("Could not resolve");
  });

  it("getItemReviews falls back to scraped web reviews when the API is empty", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ paging: { total: 0 }, reviews: [] }));

    const result = (await getItemReviews(
      client,
      { item_id: "MLA27172667" },
      new FakeScraper(null, [], [{ rating: 5, text: "great", date: "2026-01-01", country: "AR" }])
    )) as { reviews_source?: string; reviews: unknown[] };

    expect(result.reviews_source).toBe("web");
    expect(result.reviews).toHaveLength(1);
  });

  it("rankSellersForQuery groups web search offers by seller", async () => {
    // domain discovery + products/search return nothing useful; web path drives the result.
    mockFetch
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));

    const search: ScrapedSearchResult[] = [
      { title: "iPhone A", price: 1300000, original_price: null, currency: "ARS", condition: "NewCondition", free_shipping: true, rating: 4.8, seller_name: "S1", catalog_product_id: null, url: "u1" },
      { title: "iPhone B", price: 1265000, original_price: null, currency: "ARS", condition: "NewCondition", free_shipping: true, rating: 4.9, seller_name: "S2", catalog_product_id: null, url: "u2" },
      { title: "iPhone C", price: 1290000, original_price: null, currency: "ARS", condition: "NewCondition", free_shipping: false, rating: 4.7, seller_name: "S2", catalog_product_id: null, url: "u3" },
    ];

    const result = (await rankSellersForQuery(
      client,
      { query: "iphone 15", top_sellers: 2 },
      new FakeScraper(null, search)
    )) as { web_ranked_sellers: Array<Record<string, unknown>> };

    expect(result.web_ranked_sellers).toHaveLength(2);
    expect(result.web_ranked_sellers[0]).toMatchObject({ seller_name: "S2", best_price: 1265000, listing_count: 2 });
  });
});
