import { MercadoLibreClient } from "./client.js";
import { MercadoLibreError } from "./errors.js";
import {
  extractBuyBoxItemId,
  itemPrice,
  type MarketplaceItemSummary,
} from "./item-helpers.js";
import { fetchCatalogProduct, type CatalogProductPayload } from "./product-helpers.js";
import { searchItems, getSellerInfo, siteForId } from "./actions.js";
import type {
  ScrapedOffer,
  ScrapedSearchResult,
  ScraperProvider,
} from "./apify-scraper.js";
import {
  dedupeListingsBySeller,
  extractListingSellerId,
  extractSitesSearchListings,
  parseDomainDiscoveryTop,
  scoreSellerReputation,
  titleMatchesProductQuery,
  tokenizeProductQuery,
  type SitesSearchListing,
} from "./buyer-seller-ranking.js";
import type {
  FindOffersForProductQueryParams,
  GetCategoryAttributesParams,
  GetClaimParams,
  GetClaimReturnsParams,
  GetDomainDiscoveryParams,
  GetItemQuestionsParams,
  GetItemReviewsParams,
  GetListingOfferParams,
  GetMeParams,
  GetMyOrdersParams,
  GetOfficialStoreParams,
  GetOrderDiscountsParams,
  GetOrderFeedbackParams,
  GetOrderParams,
  GetOrderShipmentsParams,
  GetProductBuyboxParams,
  GetQuestionParams,
  GetShipmentParams,
  RankSellersForQueryParams,
  SearchMyClaimsParams,
} from "./buyer-schemas.js";

const MULTIGET_MAX = 20;
const DEFAULT_SCRAPE_LIMIT = Number(process.env.SCRAPE_LIMIT) || 3;
const MAX_SCRAPE_LIMIT = 5;
/**
 * Per-call timeout for the best-effort product-mode scrape that recovers the
 * seller/installments for a web search hit. Kept well under the MCP gateway
 * timeout so a slow product page degrades to the search row's price+link
 * instead of failing the whole tool call.
 */
const WEB_DETAIL_TIMEOUT_MS = Number(process.env.WEB_DETAIL_TIMEOUT_MS) || 20000;

/** Build an offer row from a scraped web result so web + API offers share one shape. */
function webOfferRow(
  source: { catalog_product_id: string; catalog_name?: string },
  offer: ScrapedOffer
): Record<string, unknown> {
  return {
    catalog_product_id: source.catalog_product_id,
    catalog_name: source.catalog_name ?? offer.title,
    listing_id: null,
    title: offer.title,
    price: offer.price,
    currency_id: offer.currency,
    condition: offer.condition,
    available_quantity: offer.available_quantity,
    sold_quantity: offer.sold_quantity,
    installments: offer.installments,
    free_shipping: offer.free_shipping,
    shipping: offer.shipping,
    rating: offer.rating,
    rating_count: offer.rating_count,
    seller_id: offer.seller_id,
    seller: offer.seller_name
      ? {
          id: offer.seller_id,
          nickname: offer.seller_name,
          reputation: offer.seller_reputation,
          is_official_store: offer.is_official_store,
        }
      : null,
    permalink: offer.url,
    price_source: "web",
    scraped_at: offer.scraped_at,
  };
}

/**
 * Build an offer row from a website search hit, optionally merged with a
 * product-page detail scrape. Search mode reliably returns the right product +
 * price + link but no seller/installments, so when the (best-effort) product
 * detail is present we layer in seller, installments, condition and shipping;
 * otherwise we keep the search hit's price + link so the user can still click
 * through and buy.
 */
function webOfferFromSearch(
  hit: ScrapedSearchResult,
  detail: ScrapedOffer | null
): Record<string, unknown> {
  const seller = detail?.seller_name
    ? {
        id: detail.seller_id,
        nickname: detail.seller_name,
        reputation: detail.seller_reputation,
        is_official_store: detail.is_official_store,
      }
    : null;
  return {
    catalog_product_id: hit.catalog_product_id,
    catalog_name: hit.title,
    listing_id: null,
    title: detail?.title ?? hit.title,
    price: detail?.price ?? hit.price,
    currency_id: detail?.currency ?? hit.currency,
    condition: detail?.condition ?? hit.condition,
    available_quantity: detail?.available_quantity ?? null,
    sold_quantity: detail?.sold_quantity ?? null,
    installments: detail?.installments ?? null,
    free_shipping: detail?.free_shipping ?? hit.free_shipping,
    shipping: detail?.shipping ?? null,
    rating: detail?.rating ?? hit.rating,
    rating_count: detail?.rating_count ?? null,
    seller_id: detail?.seller_id ?? null,
    seller,
    permalink: hit.url ?? detail?.url ?? null,
    price_source: "web",
    scraped_at: detail?.scraped_at ?? null,
  };
}

export async function getProductBuybox(
  client: MercadoLibreClient,
  params: GetProductBuyboxParams,
  scraper?: ScraperProvider
): Promise<unknown> {
  const product = await fetchCatalogProduct(client, params.product_id);
  const buyBoxItemId = extractBuyBoxItemId(product);

  let webOffer: Record<string, unknown> | null = null;
  const buyboxSite = siteForId(params.site_id, product.id);
  const buyboxUrl =
    typeof product.permalink === "string" && product.permalink.trim() !== ""
      ? product.permalink
      : catalogProductUrl(product.id, buyboxSite);
  if (!buyBoxItemId && scraper?.enabled && buyboxUrl) {
    const scraped = await scraper.scrapeProduct(buyboxUrl, {
      site_id: buyboxSite,
    });
    if (scraped) {
      webOffer = webOfferRow(
        { catalog_product_id: product.id, catalog_name: product.name },
        scraped
      );
    }
  }

  return {
    product_id: product.id,
    name: product.name,
    permalink: product.permalink,
    buy_box_winner_item_id: buyBoxItemId,
    buy_box_winner_price_range: product.buy_box_winner_price_range ?? null,
    buy_box_winner: product.buy_box_winner ?? null,
    price_source: buyBoxItemId ? "api" : webOffer ? "web" : null,
    web_offer: webOffer,
    note: buyBoxItemId
      ? "buy_box_winner already includes price/currency_id/seller_id. Use get_item with buy_box_winner_item_id only if you need more listing detail."
      : webOffer
        ? "No API buy box winner; web_offer carries the current website price (price_source: web)."
        : "No buy box winner for this catalog product, so it has no catalog price. Use rank_sellers_for_query for merchant discovery or find_offers_for_product_query for buy-box offers.",
  };
}

/**
 * Direct single-listing lookup for a publication the user pasted by id or URL.
 *
 * Why scrape instead of GET /items/{id}: the per-listing API is access_denied
 * for buyer OAuth tokens (that endpoint was removed for the same reason), so a
 * bare listing id can only be resolved to a live price/seller/shipping by
 * loading the public listing page. Fails soft: returns a structured payload
 * with offer:null + a note (never throws) when the scraper is disabled or the
 * page yields no price.
 */
export async function getListingOffer(
  params: GetListingOfferParams,
  scraper?: ScraperProvider
): Promise<unknown> {
  const raw = (params.listing ?? "").trim();
  const isUrl = /^https?:\/\//i.test(raw);
  const idMatch = /^(ML[A-Z])-?(\d+)$/.exec(raw.toUpperCase());
  const itemId = idMatch ? `${idMatch[1]}${idMatch[2]}` : null;
  const site = siteForId(params.site_id, itemId ?? undefined);
  const url = isUrl ? raw : itemId ? listingUrlFromId(itemId, site) : null;

  if (!url) {
    return {
      requested: raw,
      item_id: null,
      offer: null,
      price_source: null,
      note: "Could not resolve a Mercado Libre listing from the input. Pass a listing id like MLA1804763057 or a full listing URL.",
    };
  }

  if (!scraper?.enabled) {
    return {
      requested: raw,
      item_id: itemId,
      url,
      offer: null,
      price_source: null,
      note: "Web price enrichment is not configured (no scraper), so the listing price/shipping cannot be read directly.",
    };
  }

  const scraped = await scraper.scrapeProduct(url, { site_id: site });
  if (!scraped) {
    return {
      requested: raw,
      item_id: itemId,
      url,
      offer: null,
      price_source: null,
      note: "The listing page returned no live price (it may be sold out, paused, or not scrapeable). Try find_offers_for_product_query with the product name.",
    };
  }

  return {
    requested: raw,
    item_id: itemId,
    url: scraped.url ?? url,
    price_source: "web",
    offer: {
      item_id: itemId,
      title: scraped.title,
      price: scraped.price,
      original_price: scraped.original_price,
      discount_percentage: scraped.discount_percentage,
      currency_id: scraped.currency,
      condition: scraped.condition,
      availability: scraped.availability,
      available_quantity: scraped.available_quantity,
      sold_quantity: scraped.sold_quantity,
      installments: scraped.installments,
      free_shipping: scraped.free_shipping,
      shipping: scraped.shipping,
      rating: scraped.rating,
      rating_count: scraped.rating_count,
      seller_id: scraped.seller_id,
      seller: scraped.seller_name
        ? {
            id: scraped.seller_id,
            nickname: scraped.seller_name,
            reputation: scraped.seller_reputation,
            is_official_store: scraped.is_official_store,
          }
        : null,
      permalink: scraped.url ?? url,
      price_source: "web",
      scraped_at: scraped.scraped_at,
    },
    note: "Live website data for this specific listing (price_source: web). Exact shipping cost depends on the buyer's address; free_shipping reflects what the page shows.",
  };
}

function reviewsLookEmpty(result: unknown): boolean {
  if (!result || typeof result !== "object") return true;
  const r = result as Record<string, unknown>;
  const reviews = r.reviews;
  if (Array.isArray(reviews) && reviews.length > 0) return false;
  const paging = r.paging as { total?: number } | undefined;
  if (paging && typeof paging.total === "number" && paging.total > 0) return false;
  return true;
}

export async function getItemReviews(
  client: MercadoLibreClient,
  params: GetItemReviewsParams,
  scraper?: ScraperProvider
): Promise<unknown> {
  const qp: Record<string, string> = {};
  if (params.catalog_product_id) {
    qp.catalog_product_id = params.catalog_product_id;
  }

  let apiResult: unknown = null;
  let apiError: string | null = null;
  try {
    apiResult = await client.get(
      `/reviews/item/${encodeURIComponent(params.item_id)}`,
      Object.keys(qp).length > 0 ? qp : undefined
    );
  } catch (error) {
    apiError = error instanceof Error ? error.message : String(error);
  }

  // Fall back to scraped web reviews only when the official API gave nothing.
  const catalogId = params.catalog_product_id ?? params.item_id;
  if (scraper?.enabled && (apiError || reviewsLookEmpty(apiResult)) && /^ML[A-Z]\d/.test(catalogId)) {
    const siteId = siteForId(params.site_id, catalogId);
    const url = `https://www.mercadolibre.com.${siteTld(siteId)}/p/${catalogId}`;
    const webReviews = await scraper.scrapeReviews(url, { site_id: siteId });
    if (webReviews.length > 0) {
      return {
        reviews_source: "web",
        note: "Official reviews API returned nothing; these reviews were scraped from the product page.",
        catalog_product_id: catalogId,
        reviews: webReviews,
      };
    }
  }

  if (apiError && apiResult === null) {
    throw new Error(apiError);
  }
  return apiResult;
}

/** Mercado Libre web TLD for a site id (used to build catalog page URLs). */
function siteTld(siteId: string): string {
  const map: Record<string, string> = {
    MLA: "com.ar",
    MLB: "com.br",
    MLM: "com.mx",
    MLC: "cl",
    MCO: "com.co",
    MPE: "com.pe",
    MLU: "com.uy",
    MLV: "com.ve",
    MEC: "com.ec",
  };
  return map[siteId.toUpperCase()] ?? "com.ar";
}

/**
 * Canonical catalog product page URL. The catalog API frequently returns an
 * empty `permalink` for products with no buy box, so we synthesize the `/p/{id}`
 * URL — which the scraper resolves — from the catalog product id.
 */
function catalogProductUrl(catalogId: string, siteId: string): string | null {
  if (!/^ML[A-Z]\d/.test(catalogId)) return null;
  return `https://www.mercadolibre.${siteTld(siteId)}/p/${catalogId}`;
}

/**
 * Scrapeable listing (item) page URL from a bare item id. The slug-less
 * `articulo.../MLA-<digits>-_JM` form is the canonical short link Mercado Libre
 * redirects to the full listing page — which the scraper (a real browser)
 * follows. Returns null for non-listing ids.
 */
function listingUrlFromId(itemId: string, siteId: string): string | null {
  const m = /^(ML[A-Z])(\d+)$/.exec(itemId.toUpperCase());
  if (!m) return null;
  return `https://articulo.mercadolibre.${siteTld(siteId)}/${m[1]}-${m[2]}-_JM`;
}

export async function getCategoryAttributes(
  client: MercadoLibreClient,
  params: GetCategoryAttributesParams
): Promise<unknown> {
  return client.get(`/categories/${encodeURIComponent(params.category_id)}/attributes`);
}

export async function getDomainDiscovery(
  client: MercadoLibreClient,
  params: GetDomainDiscoveryParams
): Promise<unknown> {
  const siteId = params.site_id ?? "MLA";
  const qp: Record<string, string> = {
    q: params.query,
    limit: String(Math.min(params.limit ?? 8, 20)),
  };
  return client.get(
    `/sites/${encodeURIComponent(siteId)}/domain_discovery/search`,
    qp
  );
}

export async function getOfficialStore(
  client: MercadoLibreClient,
  params: GetOfficialStoreParams
): Promise<unknown> {
  return client.get(`/stores/${encodeURIComponent(String(params.store_id))}`);
}

export async function getItemQuestions(
  client: MercadoLibreClient,
  params: GetItemQuestionsParams
): Promise<unknown> {
  const qp: Record<string, string> = {
    item: params.item_id,
    api_version: "4",
    limit: String(Math.min(params.limit ?? 20, 50)),
  };
  if (params.offset !== undefined) {
    qp.offset = String(params.offset);
  }
  return client.get("/questions/search", qp);
}

export async function getQuestion(
  client: MercadoLibreClient,
  params: GetQuestionParams
): Promise<unknown> {
  return client.get(`/questions/${encodeURIComponent(String(params.question_id))}`, {
    api_version: "4",
  });
}

export async function getMe(
  client: MercadoLibreClient,
  _params?: GetMeParams
): Promise<unknown> {
  return client.get("/users/me");
}

export async function getMyOrders(
  client: MercadoLibreClient,
  params: GetMyOrdersParams
): Promise<unknown> {
  let buyerId = params.buyer_id;
  if (buyerId === undefined) {
    const me = await client.get<{ id: number }>("/users/me");
    buyerId = me.id;
  }
  const qp: Record<string, string> = {
    buyer: String(buyerId),
    limit: String(Math.min(params.limit ?? 20, 50)),
  };
  if (params.offset !== undefined) {
    qp.offset = String(params.offset);
  }
  if (params.status) {
    qp["order.status"] = params.status;
  }
  if (params.q) {
    qp.q = params.q;
  }
  const result = await client.get("/orders/search", qp);
  return {
    buyer_id: buyerId,
    api: "GET /orders/search?buyer=",
    result,
  };
}

export async function getOrder(
  client: MercadoLibreClient,
  params: GetOrderParams
): Promise<unknown> {
  return client.get(`/orders/${encodeURIComponent(String(params.order_id))}`);
}

export async function getOrderShipments(
  client: MercadoLibreClient,
  params: GetOrderShipmentsParams
): Promise<unknown> {
  return client.get(`/orders/${encodeURIComponent(String(params.order_id))}/shipments`);
}

export async function getShipment(
  client: MercadoLibreClient,
  params: GetShipmentParams
): Promise<unknown> {
  return client.get(`/shipments/${encodeURIComponent(String(params.shipment_id))}`);
}

export async function getOrderDiscounts(
  client: MercadoLibreClient,
  params: GetOrderDiscountsParams
): Promise<unknown> {
  return client.get(`/orders/${encodeURIComponent(String(params.order_id))}/discounts`);
}

export async function getOrderFeedback(
  client: MercadoLibreClient,
  params: GetOrderFeedbackParams
): Promise<unknown> {
  return client.get(`/orders/${encodeURIComponent(String(params.order_id))}/feedback`);
}

export async function searchMyClaims(
  client: MercadoLibreClient,
  params: SearchMyClaimsParams
): Promise<unknown> {
  const qp: Record<string, string> = {
    limit: String(Math.min(params.limit ?? 20, 50)),
  };
  if (params.offset !== undefined) {
    qp.offset = String(params.offset);
  }
  if (params.stage) {
    qp.stage = params.stage;
  }
  if (params.status) {
    qp.status = params.status;
  }
  if (params.order_id !== undefined) {
    qp.order_id = String(params.order_id);
  }
  return client.get("/post-purchase/v1/claims/search", qp);
}

export async function getClaim(
  client: MercadoLibreClient,
  params: GetClaimParams
): Promise<unknown> {
  return client.get(`/post-purchase/v1/claims/${encodeURIComponent(String(params.claim_id))}`);
}

export async function getClaimReturns(
  client: MercadoLibreClient,
  params: GetClaimReturnsParams
): Promise<unknown> {
  return client.get(
    `/post-purchase/v2/claims/${encodeURIComponent(String(params.claim_id))}/returns`
  );
}

export async function findOffersForProductQuery(
  client: MercadoLibreClient,
  params: FindOffersForProductQueryParams,
  scraper?: ScraperProvider
): Promise<unknown> {
  const siteId = params.site_id ?? "MLA";
  const catalogLimit = Math.min(params.catalog_limit ?? 15, 30);

  const searchResult = await searchItems(client, {
    query: params.query,
    site_id: siteId,
    category: params.domain_id,
    limit: catalogLimit,
  });

  const catalogResults = (searchResult as { results: Array<{ id: string; name?: string }> }).results;
  const offers: Array<Record<string, unknown>> = [];
  const catalogWithoutPrice: Array<Record<string, unknown>> = [];
  const skipped: Array<{ product_id: string; reason: string }> = [];

  for (const catalog of catalogResults) {
    let product: CatalogProductPayload;
    try {
      product = await fetchCatalogProduct(client, catalog.id);
    } catch {
      skipped.push({ product_id: catalog.id, reason: "product_fetch_failed" });
      continue;
    }

    const itemId = extractBuyBoxItemId(product);
    if (!itemId) {
      catalogWithoutPrice.push({
        catalog_product_id: catalog.id,
        catalog_name: catalog.name ?? product.name,
        permalink: product.permalink ?? null,
        buy_box_winner_price_range: product.buy_box_winner_price_range ?? null,
        note:
          "No buy-box winner for this catalog product — ML exposes no seller/price via catalog API. Use rank_sellers_for_query for merchant discovery or share the permalink with the user.",
      });
      skipped.push({ product_id: catalog.id, reason: "no_buy_box_winner" });
      continue;
    }

    let item: MarketplaceItemSummary;
    try {
      item = await client.get<MarketplaceItemSummary>(`/items/${encodeURIComponent(itemId)}`);
    } catch {
      skipped.push({ product_id: catalog.id, reason: "listing_fetch_failed" });
      continue;
    }

    const price = itemPrice(item);
    if (params.price_max !== undefined && price !== null && price > params.price_max) {
      continue;
    }
    if (params.price_min !== undefined && price !== null && price < params.price_min) {
      continue;
    }

    const row: Record<string, unknown> = {
      catalog_product_id: catalog.id,
      catalog_name: catalog.name ?? product.name,
      listing_id: item.id,
      title: item.title,
      price,
      currency_id: item.currency_id,
      condition: item.condition,
      seller_id: item.seller_id,
      permalink: item.permalink,
      free_shipping: item.shipping?.free_shipping ?? null,
      price_source: "api",
    };

    if (params.include_seller_ratings !== false && typeof item.seller_id === "number") {
      try {
        const seller = await client.get<Record<string, unknown>>(
          `/users/${encodeURIComponent(String(item.seller_id))}`
        );
        row.seller = {
          id: item.seller_id,
          nickname: seller.nickname,
          seller_reputation: seller.seller_reputation ?? null,
          power_seller_status: seller.power_seller_status ?? null,
        };
      } catch {
        row.seller = { id: item.seller_id, error: "seller_fetch_failed" };
      }
    }

    offers.push(row);
  }

  // Web offer enrichment. The catalog API (/products/search) often matches the
  // wrong or older models for niche/new products (e.g. it returns MacBook Pro
  // 14 / Air M2 for "MacBook Air M4"), and per-/p-page scraping of those wrong
  // matches then finds no price and times out. The website search ranks the
  // RIGHT listings, so we use a SINGLE search-mode scrape as the primary source
  // of web offers, then best-effort enrich the top few with a product-mode
  // scrape to recover seller/installments. Search mode is one fast run (~10s)
  // vs N parallel /p scrapes, and a slow product detail degrades to the search
  // hit's price+link instead of failing the call.
  let webEnrichedCount = 0;
  const scrapeLimit = Math.min(params.scrape_limit ?? DEFAULT_SCRAPE_LIMIT, MAX_SCRAPE_LIMIT);
  const wantWeb =
    !!scraper?.enabled &&
    scrapeLimit > 0 &&
    (offers.length === 0 || catalogWithoutPrice.length > 0);

  if (wantWeb && scraper) {
    const tokens = tokenizeProductQuery(params.query);
    const hits = await scraper
      .scrapeSearch(params.query, { site_id: siteId, limit: Math.max(scrapeLimit * 3, 10) })
      .catch(() => [] as ScrapedSearchResult[]);

    const inBudget = (price: number | null): boolean =>
      price !== null &&
      price > 0 &&
      (params.price_max === undefined || price <= params.price_max) &&
      (params.price_min === undefined || price >= params.price_min);

    const relevant = hits.filter((r) => r.title && titleMatchesProductQuery(r.title, tokens));
    const ranked = (relevant.length > 0 ? relevant : hits)
      .filter((r) => r.url && inBudget(r.price))
      .slice(0, scrapeLimit);

    // Best-effort seller/installments via product-mode (bounded timeout so a
    // slow page degrades to the search hit's price+link instead of failing).
    const details = await Promise.all(
      ranked.map((r) =>
        r.url
          ? scraper
              .scrapeProduct(r.url, { site_id: siteId, timeoutMs: WEB_DETAIL_TIMEOUT_MS })
              .catch(() => null)
          : Promise.resolve(null)
      )
    );

    for (let i = 0; i < ranked.length; i += 1) {
      offers.push(webOfferFromSearch(ranked[i], details[i]));
      webEnrichedCount += 1;
    }
  }

  // When the web search produced offers we resolved the buy intent, so we don't
  // also surface the API-priceless catalog entries (which would read as "no
  // price" and confuse the agent). Only report them when we found nothing.
  const stillWithoutPrice = webEnrichedCount > 0 ? [] : catalogWithoutPrice;

  return {
    strategy: "product_query_catalog_then_buy_box",
    intent:
      "Offers for the product the user asked to buy — resolved via catalog keyword search, not category-wide bestseller lists.",
    limitation:
      "Catalog products with an active buy-box winner return an API price + seller (price_source: api). When the catalog API exposes no price, offers are sourced from the live website search (price_source: web): each carries a price + permalink, and the top results are best-effort enriched with seller/installments. Render every offer (api + web) for the user.",
    site_id: siteId,
    query: params.query,
    price_min: params.price_min ?? null,
    price_max: params.price_max ?? null,
    offer_count: offers.length,
    web_enriched_count: webEnrichedCount,
    catalog_without_price_count: stillWithoutPrice.length,
    skipped_count: skipped.length,
    offers,
    catalog_without_price: stillWithoutPrice,
    skipped,
  };
}

async function collectSellersFromCatalogBuyBoxes(
  client: MercadoLibreClient,
  params: {
    query: string;
    site_id: string;
    domain_id?: string;
    catalog_limit: number;
    price_min?: number;
    price_max?: number;
  }
): Promise<SitesSearchListing[]> {
  const searchResult = await searchItems(client, {
    query: params.query,
    site_id: params.site_id,
    category: params.domain_id,
    limit: params.catalog_limit,
  });
  const catalogResults = (searchResult as { results: Array<{ id: string; name?: string }> })
    .results;
  const listings: SitesSearchListing[] = [];

  for (const catalog of catalogResults) {
    let product: CatalogProductPayload;
    try {
      product = await fetchCatalogProduct(client, catalog.id);
    } catch {
      continue;
    }
    const itemId = extractBuyBoxItemId(product);
    if (!itemId) {
      continue;
    }
    try {
      const item = await client.get<MarketplaceItemSummary>(`/items/${encodeURIComponent(itemId)}`);
      const price = itemPrice(item);
      if (params.price_max !== undefined && price !== null && price > params.price_max) {
        continue;
      }
      if (params.price_min !== undefined && price !== null && price < params.price_min) {
        continue;
      }
      listings.push({
        id: item.id,
        title: item.title ?? catalog.name,
        price: price ?? undefined,
        currency_id: item.currency_id,
        seller_id: item.seller_id,
        permalink: item.permalink,
        condition: item.condition,
        shipping: item.shipping,
      });
    } catch {
      continue;
    }
  }

  return listings;
}

async function collectSellersFromCategoryListings(
  client: MercadoLibreClient,
  params: { site_id: string; category_id: string; limit: number }
): Promise<SitesSearchListing[]> {
  try {
    const result = await client.get(`/sites/${encodeURIComponent(params.site_id)}/search`, {
      category: params.category_id,
      limit: String(params.limit),
    });
    return extractSitesSearchListings({ result });
  } catch (error) {
    if (error instanceof MercadoLibreError && error.status === 403) {
      return [];
    }
    throw error;
  }
}

async function fetchSellerInventoryMatchingQuery(
  client: MercadoLibreClient,
  params: {
    seller_id: number;
    query: string;
    limit: number;
    price_min?: number;
    price_max?: number;
  }
): Promise<MarketplaceItemSummary[]> {
  const itemsSearch = await client.get<{ results?: string[] }>(
    `/users/${encodeURIComponent(String(params.seller_id))}/items/search`,
    { status: "active", limit: String(Math.min(params.limit, 50)) }
  );
  const itemIds = itemsSearch.results ?? [];
  if (itemIds.length === 0) {
    return [];
  }

  const tokens = tokenizeProductQuery(params.query);
  const matched: MarketplaceItemSummary[] = [];

  for (let offset = 0; offset < itemIds.length; offset += MULTIGET_MAX) {
    const chunk = itemIds.slice(offset, offset + MULTIGET_MAX);
    const batch = await client.get<MarketplaceItemSummary[]>("/items", {
      ids: chunk.join(","),
    });
    if (!Array.isArray(batch)) {
      continue;
    }
    for (const item of batch) {
      const title = item.title ?? "";
      if (!titleMatchesProductQuery(title, tokens)) {
        continue;
      }
      const price = itemPrice(item);
      if (params.price_max !== undefined && price !== null && price > params.price_max) {
        continue;
      }
      if (params.price_min !== undefined && price !== null && price < params.price_min) {
        continue;
      }
      matched.push(item);
    }
  }

  matched.sort((a, b) => {
    const priceA = itemPrice(a) ?? Number.POSITIVE_INFINITY;
    const priceB = itemPrice(b) ?? Number.POSITIVE_INFINITY;
    return priceA - priceB;
  });

  return matched;
}

export async function rankSellersForQuery(
  client: MercadoLibreClient,
  params: RankSellersForQueryParams,
  scraper?: ScraperProvider
): Promise<unknown> {
  const siteId = params.site_id ?? "MLA";
  const topSellers = Math.min(params.top_sellers ?? 3, 10);
  const catalogLimit = Math.min(params.catalog_limit ?? 20, 30);
  const categoryLimit = Math.min(params.limit ?? 50, 50);
  const listingsPerSeller = Math.min(params.listings_per_seller ?? 50, 50);

  let domainId = params.domain_id ?? null;
  let categoryId: string | null = null;
  let categoryName: string | null = null;

  if (!domainId) {
    const discovery = await getDomainDiscovery(client, {
      query: params.query,
      site_id: siteId,
      limit: 5,
    });
    const parsed = parseDomainDiscoveryTop(discovery);
    domainId = parsed.domain_id;
    categoryId = parsed.category_id;
    categoryName = parsed.category_name;
  }

  const catalogListings = await collectSellersFromCatalogBuyBoxes(client, {
    query: params.query,
    site_id: siteId,
    domain_id: domainId ?? undefined,
    catalog_limit: catalogLimit,
    price_min: params.price_min,
    price_max: params.price_max,
  });

  let categoryListings: SitesSearchListing[] = [];
  if (categoryId) {
    categoryListings = await collectSellersFromCategoryListings(client, {
      site_id: siteId,
      category_id: categoryId,
      limit: categoryLimit,
    });
  }

  const mergedListings = dedupeListingsBySeller([...catalogListings, ...categoryListings]);

  const ranked: Array<Record<string, unknown>> = [];
  for (const listing of mergedListings) {
    const sellerId = extractListingSellerId(listing);
    if (sellerId === null) {
      continue;
    }

    const entry: Record<string, unknown> = {
      seller_id: sellerId,
      example_listing: {
        listing_id: listing.id,
        title: listing.title,
        price: listing.price ?? null,
        currency_id: listing.currency_id ?? null,
        permalink: listing.permalink ?? null,
        free_shipping: listing.shipping?.free_shipping ?? null,
      },
    };

    if (params.include_seller_ratings !== false) {
      try {
        const seller = (await getSellerInfo(client, { seller_id: sellerId })) as Record<
          string,
          unknown
        >;
        entry.seller = {
          nickname: seller.nickname,
          seller_reputation: seller.seller_reputation ?? null,
          power_seller_status: seller.power_seller_status ?? null,
        };
        entry.reputation_score = scoreSellerReputation(seller);
      } catch {
        entry.seller = { error: "seller_fetch_failed" };
        entry.reputation_score = 0;
      }
    } else {
      entry.reputation_score = 0;
    }

    ranked.push(entry);
  }

  ranked.sort((a, b) => {
    const scoreDelta = (b.reputation_score as number) - (a.reputation_score as number);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    const priceA =
      typeof (a.example_listing as Record<string, unknown>).price === "number"
        ? ((a.example_listing as Record<string, unknown>).price as number)
        : Number.POSITIVE_INFINITY;
    const priceB =
      typeof (b.example_listing as Record<string, unknown>).price === "number"
        ? ((b.example_listing as Record<string, unknown>).price as number)
        : Number.POSITIVE_INFINITY;
    return priceA - priceB;
  });

  const top = ranked.slice(0, topSellers);
  const sellersWithInventory: Array<Record<string, unknown>> = [];

  for (const sellerEntry of top) {
    const sellerId = sellerEntry.seller_id as number;
    const inventory = await fetchSellerInventoryMatchingQuery(client, {
      seller_id: sellerId,
      query: params.query,
      limit: listingsPerSeller,
      price_min: params.price_min,
      price_max: params.price_max,
    });
    sellersWithInventory.push({
      ...sellerEntry,
      listings: inventory.map((item) => ({
        listing_id: item.id,
        title: item.title,
        price: itemPrice(item),
        currency_id: item.currency_id,
        condition: item.condition,
        permalink: item.permalink,
        free_shipping: item.shipping?.free_shipping ?? null,
      })),
      listing_count: inventory.length,
    });
  }

  // Web-backed ranking: reliable even when the official seller-inventory
  // endpoints are blocked. Group scraped search offers by seller, keep the
  // cheapest per seller, and rank by price.
  let webRankedSellers: Array<Record<string, unknown>> = [];
  if (scraper?.enabled && params.include_web_offers !== false) {
    const webResults = await scraper.scrapeSearch(params.query, {
      site_id: siteId,
      limit: categoryLimit,
    });
    const bySeller = new Map<string, Record<string, unknown>>();
    for (const r of webResults) {
      if (r.price === null) continue;
      const name = r.seller_name ?? "(unknown)";
      const current = bySeller.get(name);
      const listing = {
        title: r.title,
        price: r.price,
        currency_id: r.currency,
        condition: r.condition,
        free_shipping: r.free_shipping,
        rating: r.rating,
        permalink: r.url,
      };
      if (!current) {
        bySeller.set(name, {
          seller_name: name,
          best_price: r.price,
          listing_count: 1,
          cheapest_listing: listing,
          price_source: "web",
        });
      } else {
        current.listing_count = (current.listing_count as number) + 1;
        if (r.price < (current.best_price as number)) {
          current.best_price = r.price;
          current.cheapest_listing = listing;
        }
      }
    }
    webRankedSellers = [...bySeller.values()]
      .sort((a, b) => (a.best_price as number) - (b.best_price as number))
      .slice(0, topSellers);
  }

  return {
    strategy: "domain_catalog_category_sellers",
    intent:
      "Top merchants for a product query via catalog domain discovery, buy-box/category seller discovery, reputation ranking, then each seller's active inventory filtered by query.",
    web_ranked_sellers: webRankedSellers,
    apis_used: [
      "GET /sites/{site}/domain_discovery/search",
      "GET /products/search",
      "GET /products/{id} + buy_box_winner (when present)",
      "GET /sites/{site}/search?category= (best-effort when category known)",
      "GET /users/{seller_id}/items/search",
      "GET /items?ids=",
    ],
    query: params.query,
    site_id: siteId,
    domain_id: domainId,
    category_id: categoryId,
    category_name: categoryName,
    catalog_buy_box_listings: catalogListings.length,
    category_listings: categoryListings.length,
    unique_sellers_found: ranked.length,
    top_sellers: sellersWithInventory,
    note:
      "Does not use deprecated GET /sites/{site}/search?q=. When unique_sellers_found is 0, call find_offers_for_product_query for catalog permalinks or ask ML to enable listing search.",
    fallback_when_empty: {
      tool: "find_offers_for_product_query",
      arguments: {
        query: params.query,
        site_id: siteId,
        domain_id: domainId ?? undefined,
      },
    },
  };
}

