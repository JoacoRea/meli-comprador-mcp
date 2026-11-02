/**
 * Apify-backed web enrichment for Mercado Libre catalog pages.
 *
 * Why this exists: the official ML catalog API returns no price when a
 * product has no buy-box winner (common for iPhone / MacBook / refurb), and
 * Mercado Libre blocks plain HTTP scraping (403 / login wall). This module
 * recovers the live web price and rich offer fields by calling an Apify
 * actor (a real browser behind residential proxies), so the MCP tools can
 * enrich their responses deterministically server-side instead of asking an
 * agent to drive a browser.
 *
 * The provider is hidden behind `ScraperProvider` so it can be swapped for a
 * different backend later. Every method fails soft: on missing token,
 * timeout, HTTP error, or empty dataset it returns null / [] and never
 * throws — enrichment is always best-effort and must not break a tool call.
 *
 * Config (process-wide env, read once — see README "Web price enrichment"):
 *   APIFY_TOKEN           shared Apify API token (enables enrichment)
 *   APIFY_ML_ACTOR        actor id (default "sourabhbgp~mercadolibre-scraper")
 *   APIFY_TIMEOUT_MS      per-call timeout (default 35000)
 *   SCRAPE_CACHE_TTL_MS   in-memory TTL cache (default 600000 = 10 min)
 */

const DEFAULT_ACTOR = "sourabhbgp~mercadolibre-scraper";
// A single browser scrape can take 15-30s (cold start). Default leaves room
// under a 60s MCP-gateway (Bifrost) timeout: catalog scan (~8-10s) + this < 60s.
// Tune via APIFY_TIMEOUT_MS; keep it strictly below the Bifrost tool timeout.
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_CACHE_TTL_MS = 600_000;
const APIFY_BASE = "https://api.apify.com/v2/acts";

/** Mercado Libre site id → Apify `country` code. Defaults to AR. */
const SITE_TO_COUNTRY: Record<string, string> = {
  MLA: "AR",
  MLB: "BR",
  MLM: "MX",
  MLC: "CL",
  MCO: "CO",
  MPE: "PE",
  MLU: "UY",
  MLV: "VE",
  MEC: "EC",
  MBO: "BO",
  MPY: "PY",
  MGT: "GT",
  MCR: "CR",
  MPA: "PA",
  MRD: "DO",
  MHN: "HN",
  MSV: "SV",
  MNI: "NI",
};

export function siteToCountry(siteId?: string): string {
  if (!siteId) return "AR";
  return SITE_TO_COUNTRY[siteId.toUpperCase()] ?? "AR";
}

/** Normalized single-offer record returned to the MCP tools. */
export interface ScrapedOffer {
  price: number | null;
  original_price: number | null;
  discount_percentage: number | null;
  currency: string | null;
  condition: string | null;
  availability: string | null;
  available_quantity: number | null;
  sold_quantity: number | null;
  installments: unknown;
  free_shipping: boolean | null;
  shipping: unknown;
  rating: number | null;
  rating_count: number | null;
  seller_id: number | null;
  seller_name: string | null;
  seller_reputation: unknown;
  is_official_store: boolean | null;
  title: string | null;
  url: string | null;
  scraped_at: string | null;
}

/** Normalized search-result card. */
export interface ScrapedSearchResult {
  title: string | null;
  price: number | null;
  original_price: number | null;
  currency: string | null;
  condition: string | null;
  free_shipping: boolean | null;
  rating: number | null;
  seller_name: string | null;
  catalog_product_id: string | null;
  url: string | null;
}

/** Normalized seller storefront snapshot. */
export interface ScrapedSeller {
  seller_name: string | null;
  reputation: unknown;
  is_official_store: boolean | null;
  followers: number | null;
  catalog: ScrapedSearchResult[];
  url: string | null;
}

/** Normalized review. */
export interface ScrapedReview {
  rating: number | null;
  text: string | null;
  date: string | null;
  country: string | null;
}

export interface ScraperProvider {
  /** True when an Apify token is configured and enrichment can run. */
  readonly enabled: boolean;
  scrapeProduct(
    url: string,
    opts?: { site_id?: string; timeoutMs?: number }
  ): Promise<ScrapedOffer | null>;
  scrapeSearch(
    query: string,
    opts?: { site_id?: string; limit?: number }
  ): Promise<ScrapedSearchResult[]>;
  scrapeSeller(
    sellerUrl: string,
    opts?: { site_id?: string }
  ): Promise<ScrapedSeller | null>;
  scrapeReviews(
    url: string,
    opts?: { site_id?: string; max?: number }
  ): Promise<ScrapedReview[]>;
}

/** Raw actor row shapes — only the fields we consume are typed. */
interface ApifyProductRow {
  title?: string;
  price?: number | string;
  originalPrice?: number | string | null;
  discountPercentage?: number | null;
  currency?: string;
  condition?: string;
  availability?: string;
  availableQuantity?: number;
  soldQuantity?: number;
  installments?: unknown;
  freeShipping?: boolean;
  shipping?: unknown;
  rating?: number;
  ratingCount?: number;
  sellerId?: number | string;
  sellerName?: string;
  sellerReputation?: unknown;
  isOfficialStore?: boolean;
  url?: string;
  canonicalUrl?: string;
  productId?: string;
  catalogProductId?: string;
  scrapedAt?: string;
  followers?: number;
  reviews?: ApifyReviewRow[];
}

interface ApifyReviewRow {
  rating?: number;
  stars?: number;
  text?: string;
  content?: string;
  reviewText?: string;
  date?: string;
  country?: string;
}

type CacheEntry = { expires: number; value: unknown };

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.,-]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function toStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export class ApifyScraper implements ScraperProvider {
  private readonly token: string | undefined;
  private readonly actor: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.token = env.APIFY_TOKEN?.trim() || undefined;
    this.actor = env.APIFY_ML_ACTOR?.trim() || DEFAULT_ACTOR;
    this.timeoutMs = Number(env.APIFY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = Number(env.SCRAPE_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS;
  }

  get enabled(): boolean {
    return this.token !== undefined;
  }

  /**
   * Run the actor synchronously and return its dataset items. Never throws:
   * any failure (no token, timeout, non-2xx, malformed body) resolves to [].
   */
  private async runActor(
    input: Record<string, unknown>,
    cacheKey: string,
    timeoutMs?: number
  ): Promise<unknown[]> {
    if (!this.token) return [];

    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return cached.value as unknown[];
    }

    const effectiveTimeout = Math.max(2000, Math.min(timeoutMs ?? this.timeoutMs, this.timeoutMs));
    const url = `${APIFY_BASE}/${encodeURIComponent(this.actor)}/run-sync-get-dataset-items`;
    try {
      const res = await fetch(url, {
        method: "POST",
        // Token in the header, not the query string, so it never shows up in URLs.
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(effectiveTimeout),
      });
      if (!res.ok) {
        this.logFailure("apify_http_error", { status: res.status, actor: this.actor });
        return [];
      }
      const body = (await res.json()) as unknown;
      const rows = Array.isArray(body) ? body : [];
      this.cache.set(cacheKey, { expires: Date.now() + this.cacheTtlMs, value: rows });
      return rows;
    } catch (error) {
      this.logFailure("apify_request_failed", {
        actor: this.actor,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private logFailure(msg: string, fields: Record<string, unknown>): void {
    // stderr only — stdout is reserved for the MCP JSON-RPC transport.
    console.error(JSON.stringify({ level: "warn", msg, ...fields }));
  }

  private normalizeProduct(row: ApifyProductRow): ScrapedOffer {
    return {
      price: toNumber(row.price),
      original_price: toNumber(row.originalPrice),
      discount_percentage: typeof row.discountPercentage === "number" ? row.discountPercentage : null,
      currency: toStr(row.currency),
      condition: toStr(row.condition),
      availability: toStr(row.availability),
      available_quantity: typeof row.availableQuantity === "number" ? row.availableQuantity : null,
      sold_quantity: typeof row.soldQuantity === "number" ? row.soldQuantity : null,
      installments: row.installments ?? null,
      free_shipping: toBool(row.freeShipping),
      shipping: row.shipping ?? null,
      rating: typeof row.rating === "number" ? row.rating : null,
      rating_count: typeof row.ratingCount === "number" ? row.ratingCount : null,
      seller_id: toNumber(row.sellerId),
      seller_name: toStr(row.sellerName),
      seller_reputation: row.sellerReputation ?? null,
      is_official_store: toBool(row.isOfficialStore),
      title: toStr(row.title),
      url: toStr(row.canonicalUrl) ?? toStr(row.url),
      scraped_at: toStr(row.scrapedAt),
    };
  }

  private normalizeSearch(row: ApifyProductRow): ScrapedSearchResult {
    return {
      title: toStr(row.title),
      price: toNumber(row.price),
      original_price: toNumber(row.originalPrice),
      currency: toStr(row.currency),
      condition: toStr(row.condition),
      free_shipping: toBool(row.freeShipping),
      rating: typeof row.rating === "number" ? row.rating : null,
      seller_name: toStr(row.sellerName),
      catalog_product_id: toStr(row.catalogProductId) ?? toStr(row.productId),
      url: toStr(row.canonicalUrl) ?? toStr(row.url),
    };
  }

  async scrapeProduct(
    url: string,
    opts?: { site_id?: string; timeoutMs?: number }
  ): Promise<ScrapedOffer | null> {
    if (!this.enabled) return null;
    const country = siteToCountry(opts?.site_id);
    const rows = await this.runActor(
      {
        mode: "product",
        country,
        productUrls: [url],
        maxItems: 1,
        includeReviews: false,
        includeQuestions: false,
        includeVariations: false,
      },
      `product:${country}:${url}`,
      opts?.timeoutMs
    );
    const first = rows[0] as ApifyProductRow | undefined;
    if (!first) return null;
    const offer = this.normalizeProduct(first);
    // price 0 means the page had no real offer — treat as "no price".
    return offer.price !== null && offer.price > 0 ? offer : null;
  }

  async scrapeSearch(
    query: string,
    opts?: { site_id?: string; limit?: number }
  ): Promise<ScrapedSearchResult[]> {
    if (!this.enabled) return [];
    const country = siteToCountry(opts?.site_id);
    const maxItems = Math.min(opts?.limit ?? 10, 50);
    const rows = await this.runActor(
      { mode: "search", country, searchQuery: query, maxItems },
      `search:${country}:${maxItems}:${query.toLowerCase()}`
    );
    return rows
      .map((r) => this.normalizeSearch(r as ApifyProductRow))
      .filter((r) => r.price !== null && r.price > 0);
  }

  async scrapeSeller(sellerUrl: string, opts?: { site_id?: string }): Promise<ScrapedSeller | null> {
    if (!this.enabled) return null;
    const country = siteToCountry(opts?.site_id);
    const rows = await this.runActor(
      { mode: "seller", country, sellerUrls: [sellerUrl], includeFeaturedItems: false },
      `seller:${country}:${sellerUrl}`
    );
    if (rows.length === 0) return null;
    const profile = rows[0] as ApifyProductRow;
    const catalog = rows
      .slice(1)
      .map((r) => this.normalizeSearch(r as ApifyProductRow))
      .filter((r) => r.price !== null || r.title !== null);
    return {
      seller_name: toStr(profile.sellerName),
      reputation: profile.sellerReputation ?? null,
      is_official_store: toBool(profile.isOfficialStore),
      followers: typeof profile.followers === "number" ? profile.followers : null,
      catalog,
      url: toStr(profile.url),
    };
  }

  async scrapeReviews(
    url: string,
    opts?: { site_id?: string; max?: number }
  ): Promise<ScrapedReview[]> {
    if (!this.enabled) return [];
    const country = siteToCountry(opts?.site_id);
    const maxItems = Math.min(opts?.max ?? 50, 500);
    const rows = await this.runActor(
      { mode: "reviews", country, productUrls: [url], maxItems },
      `reviews:${country}:${maxItems}:${url}`
    );
    return rows.map((r) => {
      const row = r as ApifyReviewRow;
      return {
        rating: typeof row.rating === "number" ? row.rating : typeof row.stars === "number" ? row.stars : null,
        text: toStr(row.text) ?? toStr(row.content) ?? toStr(row.reviewText),
        date: toStr(row.date),
        country: toStr(row.country),
      };
    });
  }
}

let singleton: ScraperProvider | null = null;

/**
 * Process-wide scraper singleton. Lazily constructed from env so the TTL
 * cache is shared across MCP requests (each request builds its own client +
 * tools, but they all share this one scraper).
 */
export function getScraper(): ScraperProvider {
  if (singleton === null) {
    singleton = new ApifyScraper();
  }
  return singleton;
}

/** Test seam — reset the singleton between unit tests. */
export function __resetScraperForTests(provider: ScraperProvider | null): void {
  singleton = provider;
}
