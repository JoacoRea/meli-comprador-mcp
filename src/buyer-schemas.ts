export interface GetProductBuyboxParams {
  product_id: string;
  /** Site id (e.g. MLA) for web price-enrichment country. Derived from product_id when omitted. */
  site_id?: string;
}

export interface GetItemReviewsParams {
  item_id: string;
  catalog_product_id?: string;
  /** Site id (e.g. MLA) for web-review fallback country. Derived from the id when omitted. */
  site_id?: string;
}

export interface GetCategoryAttributesParams {
  category_id: string;
}

export interface GetDomainDiscoveryParams {
  query: string;
  site_id?: string;
  limit?: number;
}

export interface GetOfficialStoreParams {
  store_id: number;
}

export interface GetItemQuestionsParams {
  item_id: string;
  limit?: number;
  offset?: number;
}

export interface GetQuestionParams {
  question_id: number;
}

export interface GetMeParams {
  // token-only
}

export interface GetMyOrdersParams {
  buyer_id?: number;
  status?: string;
  limit?: number;
  offset?: number;
  q?: string;
}

export interface GetOrderParams {
  order_id: number;
}

export interface GetOrderShipmentsParams {
  order_id: number;
}

export interface GetShipmentParams {
  shipment_id: number;
}

export interface GetOrderDiscountsParams {
  order_id: number;
}

export interface GetOrderFeedbackParams {
  order_id: number;
}

export interface SearchMyClaimsParams {
  stage?: string;
  status?: string;
  order_id?: number;
  limit?: number;
  offset?: number;
}

export interface GetClaimParams {
  claim_id: number;
}

export interface GetClaimReturnsParams {
  claim_id: number;
}

/**
 * Direct single-listing lookup. For when the user pastes one specific
 * publication (e.g. "precio y envío de MLA1804763057" or a listing URL) and
 * wants its price/shipping/seller. The per-listing /items API is access_denied
 * for buyer tokens, so this recovers the data by scraping the listing page.
 */
export interface GetListingOfferParams {
  /** A listing/item id (e.g. MLA1804763057) or a full Mercado Libre listing/catalog URL. */
  listing: string;
  /** Site id (e.g. MLA) for the scrape country. Derived from the id/URL when omitted. */
  site_id?: string;
}

/** Product-scoped catalog → buy-box offers, with live web price enrichment. */
export interface FindOffersForProductQueryParams {
  query: string;
  site_id?: string;
  domain_id?: string;
  price_max?: number;
  price_min?: number;
  catalog_limit?: number;
  include_seller_ratings?: boolean;
  /**
   * Max web offers returned (sourced from the website search and best-effort
   * enriched with seller/installments). Default SCRAPE_LIMIT env or 3, capped
   * at 5. Set 0 to disable web price enrichment for this call.
   */
  scrape_limit?: number;
}

export interface RankSellersForQueryParams {
  query: string;
  site_id?: string;
  /** Catalog domain filter (e.g. MLA-NOTEBOOKS). Resolved via domain_discovery when omitted. */
  domain_id?: string;
  price_max?: number;
  price_min?: number;
  /** Catalog products to scan for buy-box sellers (default 20, max 30). */
  catalog_limit?: number;
  /** Category listing scan size when category_id is known (default 50, max 50). */
  limit?: number;
  /** How many ranked sellers to return (default 3, max 10). */
  top_sellers?: number;
  /** Max active listings per top seller to inspect (default 50, max 50). */
  listings_per_seller?: number;
  include_seller_ratings?: boolean;
  /**
   * Also return web_ranked_sellers built from the scraper's search results
   * (sellers + live prices) — reliable even when the official seller-inventory
   * endpoints are blocked. Default true when a scraper token is configured.
   */
  include_web_offers?: boolean;
}

