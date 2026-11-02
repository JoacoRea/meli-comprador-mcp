import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  getInboundAuthContext,
  getRequestAccessToken,
  getRequestInboundHeaders,
  runWithRequestAccessToken,
  type RedactedInboundHeaders,
} from "./client.js";
import { MercadoLibreError } from "./errors.js";
import type { createMercadoLibreTools } from "./index.js";

type Tools = ReturnType<typeof createMercadoLibreTools>["tools"];
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Headers we redact before stashing in AsyncLocalStorage / emitting on
 * error. Bearer + cookies are sensitive; everything else (including
 * `traceparent`, `x-request-id`, Bifrost's `x-bf-eh-*` family, etc.) is
 * kept verbatim so an operator can join with upstream traces.
 */
const REDACTED_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-amz-security-token",
]);

function redactInboundHeaders(
  headers: ToolExtra["requestInfo"] extends infer R
    ? R extends { headers?: infer H }
      ? H | undefined
      : undefined
    : undefined
): RedactedInboundHeaders | undefined {
  if (!headers) return undefined;
  const out: RedactedInboundHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = REDACTED_HEADER_NAMES.has(name.toLowerCase()) ? "[redacted]" : value;
  }
  return out;
}

function resolveBearerToken(extra: ToolExtra): string | undefined {
  const rawAuthorization = extra.requestInfo?.headers?.authorization;
  if (!rawAuthorization) return undefined;
  const authorization =
    typeof rawAuthorization === "string" ? rawAuthorization : rawAuthorization.join(", ");

  const [scheme, token] = authorization.split(" ");
  if (!scheme || !token) return undefined;
  if (scheme.toLowerCase() !== "bearer") return undefined;
  return token.trim() || undefined;
}

/**
 * One JSON-line log on stderr per failed tool call. `level: "error"`
 * lets ClickStack / OTel collectors classify the entry as SeverityText=
 * ERROR. Includes:
 *   - the redacted inbound auth context (source/prefix/fp)
 *   - the redacted inbound MCP request headers (e.g. `traceparent` so
 *     pod logs can be joined with Bifrost / OTel traces)
 *   - the MercadoLibre call's method/path/status, the response body,
 *     and the response headers (e.g. `x-request-id` for ML support
 *     tickets, `x-rate-limit-*` for 429 diagnosis)
 *
 * Verbose by design — we want maximum signal during the per-user OAuth
 * rollout. Tighten the field set in a follow-up once the wiring is stable.
 *
 * stderr, not stdout — the stdio transport reserves stdout for JSON-RPC.
 */
function logToolError(error: unknown): void {
  const auth = getInboundAuthContext();
  const inboundHeaders = getRequestInboundHeaders();
  const base: Record<string, unknown> = {
    level: "error",
    msg: "meli_tool_error",
    inbound_source: auth.source,
    inbound_prefix: auth.prefix,
    inbound_fp: auth.fp,
    inbound_headers: inboundHeaders ?? {},
  };
  if (error instanceof MercadoLibreError) {
    console.error(
      JSON.stringify({
        ...base,
        method: error.method,
        path: error.path,
        status: error.status,
        response_headers: error.responseHeaders ?? {},
        response_body: error.body,
        error: error.message,
      })
    );
    return;
  }
  console.error(
    JSON.stringify({
      ...base,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}

function toolPayloadIndicatesFailure(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  return (result as Record<string, unknown>).blocked === true;
}

function toolResult(
  handler: () => Promise<unknown>,
  extra?: ToolExtra
): () => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  return async () => {
    try {
      // Inherit the token the outer `wrapToolWithRequestTokenContext`
      // wrapper already put in the request context when this call site did
      // not forward `extra`. Without the fallback, a tool registered as
      // `toolResult(() => tools.x(params))` (no `extra`) re-runs the handler
      // in a fresh context with `accessToken = undefined`, dropping the
      // Authorization header → ML 401 "authorization value not present".
      const token = (extra ? resolveBearerToken(extra) : undefined) ?? getRequestAccessToken();
      const result = await runWithRequestAccessToken(token, handler);
      const isError = toolPayloadIndicatesFailure(result);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        ...(isError ? { isError: true } : {}),
      };
    } catch (error) {
      logToolError(error);
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  };
}

function wrapToolWithRequestTokenContext(server: McpServer): void {
  const originalTool = server.tool.bind(server);
  const toolWithToken = ((...args: unknown[]) => {
    const callbackIndex = args.length - 1;
    const originalCallback = args[callbackIndex];
    if (typeof originalCallback !== "function") return (originalTool as (...a: unknown[]) => unknown)(...args);

    const wrappedCallback = (...callbackArgs: unknown[]) => {
      const maybeExtra = callbackArgs[callbackArgs.length - 1] as ToolExtra | undefined;
      const token = maybeExtra ? resolveBearerToken(maybeExtra) : undefined;
      const headers = redactInboundHeaders(maybeExtra?.requestInfo?.headers);
      return runWithRequestAccessToken(
        token,
        async () => originalCallback(...callbackArgs) as Promise<unknown>,
        headers
      );
    };

    args[callbackIndex] = wrappedCallback;
    return (originalTool as (...a: unknown[]) => unknown)(...args);
  }) as typeof server.tool;

  server.tool = toolWithToken;
}

export function registerMercadoLibreTools(server: McpServer, tools: Tools): void {
  wrapToolWithRequestTokenContext(server);
  server.tool(
    "search_items",
    "Search MercadoLibre CATALOG products by keyword (GET /products/search). Returns catalog product ids (e.g. MLA26385767) which have NO price and are NOT listing/item ids. Set include_web_prices:true to also get a web_offers[] array with live scraped prices (price_source: web). For buy-box offers use find_offers_for_product_query. Never pass catalog ids to get_item/get_items_bulk.",
    {
      query: z.string(),
      site_id: z.string().optional(),
      category: z.string().optional().describe("domain_id filter e.g. MLA-CELLPHONES"),
      price_min: z.number().optional(),
      price_max: z.number().optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
      include_web_prices: z
        .boolean()
        .optional()
        .describe("Also return web_offers[] with live scraped prices (price_source: web)."),
    },
    async (params, extra) => toolResult(() => tools.search_items(params), extra)()
  );

  server.tool(
    "find_offers_for_product_query",
    "PRIMARY product-scoped offer tool when the user asks to buy a specific product (e.g. iPhone 15, MacBook Air). Chain: GET /products/search?q= → GET /products/{id} buy box → GET /items/{listing_id}. Returns offers[] with price+seller; each offer carries price_source ('api' from the buy box, 'web' from live scraping). Products with neither still appear in catalog_without_price (permalink, no price). NOT category-wide /highlights bestsellers.",
    {
      query: z.string(),
      site_id: z.string().optional(),
      domain_id: z.string().optional(),
      price_max: z.number().optional(),
      price_min: z.number().optional(),
      catalog_limit: z.number().optional().describe("Max catalog products to scan (default 15)"),
      include_seller_ratings: z.boolean().optional(),
      scrape_limit: z
        .number()
        .optional()
        .describe(
          "Max no-buy-box catalog products to enrich with a live web price (default 3, max 5; 0 disables web enrichment)."
        ),
    },
    async (params, extra) => toolResult(() => tools.find_offers_for_product_query(params), extra)()
  );

  server.tool(
    "get_listing_offer",
    "Read price + shipping + seller for ONE specific listing the user pastes by id or URL (e.g. 'pasame el precio y envío de MLA1804763057' or a listing link). Pass the id (MLA…) or full URL in `listing`. Returns live website data (price_source: web): price, installments, free_shipping/shipping, condition, availability and seller. There is NO catalog/API tool for a bare listing id (get_item is gone) — use this for a single known publication; use find_offers_for_product_query when the user names a product instead. A bare catalog product id (e.g. from search_items) also works: it falls back to the catalog page's best offer (resolved_as: catalog_product). Delivery dates reflect the scraper's location, not the buyer's; free_shipping reflects what the page shows.",
    {
      listing: z
        .string()
        .describe("Listing/item id (e.g. MLA1804763057) or a full Mercado Libre listing/catalog URL."),
      site_id: z.string().optional(),
    },
    async (params) => toolResult(() => tools.get_listing_offer(params))()
  );

  server.tool(
    "get_product",
    "Catalog product datasheet (GET /products/{id}).",
    { product_id: z.string() },
    async (params) => toolResult(() => tools.get_product(params))()
  );

  server.tool(
    "get_product_buybox",
    "Catalog buy-box winner for a product. buy_box_winner (when present) already contains price/currency_id/seller_id (price_source: api). When there is no winner, web_offer carries the live website price (price_source: web) if a scraper is configured.",
    {
      product_id: z.string(),
      site_id: z
        .string()
        .optional()
        .describe("Site id for web-price country (e.g. MLA). Derived from product_id when omitted."),
    },
    async (params) => toolResult(() => tools.get_product_buybox(params))()
  );

  server.tool(
    "get_item_description",
    "Listing description or catalog short_description.",
    { item_id: z.string() },
    async (params) => toolResult(() => tools.get_item_description(params))()
  );

  server.tool(
    "get_item_reviews",
    "Product reviews and rating_average (GET /reviews/item/{id}). Falls back to scraped web reviews (reviews_source: web) when the official API returns nothing and a catalog id + scraper are available.",
    {
      item_id: z.string(),
      catalog_product_id: z.string().optional(),
      site_id: z
        .string()
        .optional()
        .describe("Site id for the web-review fallback country (e.g. MLA). Derived from the id when omitted."),
    },
    async (params) => toolResult(() => tools.get_item_reviews(params))()
  );

  server.tool(
    "get_seller_info",
    "Seller profile and reputation. Set include_catalog:true to also scrape the seller storefront (web_storefront with live catalog + reputation).",
    {
      seller_id: z.number(),
      site_id: z.string().optional().describe("Site id for the storefront scrape country (default MLA)."),
      include_catalog: z
        .boolean()
        .optional()
        .describe("Also return web_storefront with the seller's live catalog (price_source: web)."),
    },
    async (params) => toolResult(() => tools.get_seller_info(params))()
  );

  server.tool(
    "get_item_questions",
    "Q&A on a listing (GET /questions/search?item=).",
    {
      item_id: z.string(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async (params) => toolResult(() => tools.get_item_questions(params))()
  );
}
