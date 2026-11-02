import { MercadoLibreClient, type AccessTokenProvider } from "./client.js";
import { getScraper } from "./apify-scraper.js";
import { searchItems, getProduct, getItemDescription, getSellerInfo } from "./actions.js";
import {
  getProductBuybox,
  getListingOffer,
  getItemReviews,
  getItemQuestions,
  findOffersForProductQuery,
} from "./buyer-actions.js";
import type {
  SearchItemsParams,
  GetProductParams,
  GetItemDescriptionParams,
  GetSellerInfoParams,
} from "./schemas.js";
import type {
  GetProductBuyboxParams,
  GetListingOfferParams,
  GetItemReviewsParams,
  GetItemQuestionsParams,
  FindOffersForProductQueryParams,
} from "./buyer-schemas.js";

/**
 * Read-only buyer tool set. Keep this list in sync with
 * `registerMercadoLibreTools` (src/mcp-tools.ts) and with
 * `BUYER_READONLY_TOOLS` — tests/mcp-server.test.ts asserts the exact set.
 */
export const BUYER_READONLY_TOOLS = [
  "search_items",
  "find_offers_for_product_query",
  "get_product",
  "get_product_buybox",
  "get_listing_offer",
  "get_item_description",
  "get_item_reviews",
  "get_seller_info",
  "get_item_questions",
] as const;

/**
 * @param auth Either a static access token, or an `AccessTokenProvider`
 *   (e.g. the auto-refreshing `TokenManager`).
 */
export function createMercadoLibreTools(auth?: string | AccessTokenProvider) {
  const client = new MercadoLibreClient(auth);
  const scraper = getScraper();

  return {
    tools: {
      search_items: (params: SearchItemsParams) => searchItems(client, params, scraper),
      find_offers_for_product_query: (params: FindOffersForProductQueryParams) =>
        findOffersForProductQuery(client, params, scraper),
      get_product: (params: GetProductParams) => getProduct(client, params),
      get_product_buybox: (params: GetProductBuyboxParams) =>
        getProductBuybox(client, params, scraper),
      get_listing_offer: (params: GetListingOfferParams) =>
        getListingOffer(params, scraper),
      get_item_description: (params: GetItemDescriptionParams) =>
        getItemDescription(client, params),
      get_item_reviews: (params: GetItemReviewsParams) =>
        getItemReviews(client, params, scraper),
      get_seller_info: (params: GetSellerInfoParams) =>
        getSellerInfo(client, params, scraper),
      get_item_questions: (params: GetItemQuestionsParams) => getItemQuestions(client, params),
    },
  };
}

export { MercadoLibreClient } from "./client.js";
export type { AccessTokenProvider } from "./client.js";
export { MercadoLibreError } from "./errors.js";
export * from "./actions.js";
export * from "./buyer-actions.js";
export type * from "./schemas.js";
export type * from "./buyer-schemas.js";
