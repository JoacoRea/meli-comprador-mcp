# Changelog — meli-comprador-mcp

## 2.0.0 (fork of @kolmena-ai/meli-mcp 1.10.6)

- **Breaking:** read-only buyer fork. Only `search_items`, `find_offers_for_product_query`, `get_product`, `get_product_buybox`, `get_listing_offer`, `get_item_description`, `get_item_reviews`, `get_seller_info`, `get_item_questions` remain; a test enforces the exact list. `MercadoLibreClient` is GET-only.
- **Auto-refreshing OAuth tokens:** `pnpm auth` + file token store, refresh 5 min before expiry, rotated refresh token always saved, single retry on 401, renewal serialized across calls and processes.
- Apify token sent via `Authorization` header.

---

Entries below are from upstream `@kolmena-ai/meli-mcp`.

## 1.10.6

### Fix `seller_list_feedback` + add `seller_get_order_feedback`

`GET /feedback/receiver/{user_id}` is not in Mercado Libre docs and returns 404.

- **`seller_list_feedback`** — scans `GET /orders/search?seller={id}` then `GET /orders/{id}/feedback` per order; returns the **purchase** side (buyer → seller). Use `feedback_id` with `seller_reply_feedback`.
- **`seller_get_order_feedback`** — single-order `GET /orders/{order_id}/feedback` with seller ownership check.

### Add `seller_send_pack_message`

Post-sale replies were read-only (`seller_list_message_packs`, `seller_get_pack_messages`) with no send tool.

- **`seller_send_pack_message`** — `POST /messages/packs/{pack_id}/sellers/{seller_id}?tag=post_sale` (max 350 chars). `buyer_id` optional when inferable from the pack thread.

## 1.10.5

### Fix post-sale messages endpoints (`seller_list_message_packs`, `seller_get_pack_messages`)

`GET /marketplace/messages/pending` is not in current Mercado Libre docs and returns 403 for domestic MLA sellers.

- **`seller_list_message_packs`** — now calls `GET /messages/unread?role=seller&tag=post_sale` (domestic). Falls back to `GET /marketplace/messages/unread` for Global Selling sellers. Clearer unavailable message (incl. Model 6 block).
- **`seller_get_pack_messages`** — fixed path to `GET /messages/packs/{pack_id}/sellers/{seller_id}?tag=post_sale` (was wrong `/messages/packs/{id}/messages`). Default `mark_as_read=false`.

## 1.10.4

### Add `seller_create_catalog_listing` — catalog opt-in (POST /items/catalog_listings)

Traditional marketplace items with `catalog_product_id` are not yet competing on the catalog product page — `seller_get_item_price_to_win` returns `item_not_opted_in` until the seller opts in.

- **New tool `seller_create_catalog_listing`** — `POST /items/catalog_listings` with `item_id` + `catalog_product_id` (+ optional `variation_id` when 2+ variations; auto-selected when only one). Returns `catalog_listing_id` to use with `seller_get_item_price_to_win`. Requires explicit seller approval in agent skills.
- **`seller_get_item_price_to_win`** now calls `?version=v2` per ML catalog competition docs.

## 1.10.3

### Fix `seller_add_listing_pictures` — variations + post-PUT verification

The tool PUT `pictures[]` at item root and returned success, but the live listing often still showed one photo. Two causes:

1. **Items with variations** — Mercado Libre requires the new picture id in **each variation's `picture_ids[]`** as well as in item-level `pictures[]`, and every existing variation id must be sent or variations are dropped ([Working with pictures](https://developers.mercadolibre.com.ar/en_us/categories-and-attributes/working-with-pictures)). v1.10.2 only updated item-level pictures.
2. **Catalog listings** — `catalog_listing` items inherit photos from ML catalog; seller PUT may succeed but the public page won't show seller-added images ([Catalog listing guide](https://global-selling.mercadolibre.com/learning-center/news/guide-on-your-catalog-listings)).

- **`seller_add_listing_pictures`** now merges `picture_ids` into **all variations** when present, then **GET /items/{id}** after PUT and returns `verified`, `verified_picture_count`, and a `warning` when counts don't match.
- **Catalog listings** (`catalog_listing: true`) fail fast with a clear message instead of a false success.

## 1.10.2

### Add `seller_add_listing_pictures` — attach uploaded images to existing listings

Mateo (and other seller agents) could upload images via `seller_upload_listing_picture` but had no way to attach them to an **existing** ad. Calling `seller_update_my_item` with `picture_ids` failed with *"Provide at least one of price, available_quantity, or status to update"* because that tool only handles price/stock/status.

Mercado Libre attaches pictures to active listings via `PUT /items/{id}` with a `pictures[]` array. When **adding** images you must send **existing picture ids plus the new ones** — omitting current ids drops them from the listing.

- **New tool `seller_add_listing_pictures`** — default **add** mode reads the item's current `pictures`, merges in new `picture_ids` (from upload) and/or `picture_sources` (HTTPS URLs), and PUTs the combined array. Optional `replace_pictures: true` to set the full set explicitly.
- **`seller_update_my_item`** description clarified: price/stock/status only — **not** pictures.
- **`seller_upload_listing_picture`** description updated to point at `seller_add_listing_pictures` for existing listings.

## 1.10.1

### Fix `seller_get_listing_health` / `seller_audit_listings` — migrate off the discontinued `/health` endpoint

`seller_get_listing_health` called `GET /items/{id}/health`, which Mercado Libre **discontinued (Feb 2026)**. For marketplace (`buy_it_now`) items the endpoint now returns `404 "Items with buying mode 'buy_it_now' are not allowed"`, so every health lookup failed and `seller_audit_listings` reported a `health_error` per item. This had nothing to do with the listing's state (catalog linkage, free shipping, etc.) — the endpoint was simply gone.

- **`seller_get_listing_health` now calls `GET /item/{id}/performance`** (note the singular `/item/`), the replacement ML groups all listing-quality data into: `score` (0-100), `level` / `level_wording` (Básica / Estándar / Profesional), and `buckets[]` of per-area `OPPORTUNITY`/`WARNING` actions (title, pictures, GTIN, technical specs, …). The tool name and arguments are unchanged; the result now carries `performance` instead of `health`.
- **`seller_audit_listings`** consumes the same function, so it returns `performance` (and `performance_error` on failure) per item and works again.

## 1.10.0

### Add `get_listing_offer` — price/shipping for a single pasted listing

When a buyer pastes **one specific publication** ("pasame el precio y envío de la publicación MLA1804763057", or a listing URL), there was no tool to answer it: the per-listing `/items/{id}` API is `access_denied` for buyer OAuth tokens (which is why `get_item` / `get_item_shipping_options` were removed in 1.9.6), and the remaining tools are all catalog/product-query scoped. The agent ended up guessing the removed `get_item_shipping_options` and surfacing "the tool isn't available in my configuration."

- **New tool `get_listing_offer`** takes a `listing` (a listing/item id like `MLA1804763057` **or** a full listing/`/p/` URL) and an optional `site_id`, and returns the live website offer (`price_source: web`): `price`, `original_price`, `installments`, `free_shipping`/`shipping`, `condition`, `availability` and `seller`. It resolves a bare id to the canonical `articulo.mercadolibre.<tld>/MLA-<digits>-_JM` listing URL and recovers the data with the existing Apify scraper (same path already used to enrich search-hit listing URLs).
- **Fails soft**: returns `offer: null` + a human note (never throws) when the scraper is disabled, the input isn't a resolvable listing, or the page yields no price (sold out / paused / unscrapeable) — the buyer skill then falls back to `find_offers_for_product_query` on the product name.
- **Shipping caveat**: `free_shipping` reflects the page; an exact shipping cost depends on the buyer's address (quoted at checkout), so the tool/skill never invent a shipping figure.

## 1.9.6

### Remove buyer-inaccessible / decommissioned / legacy tools

These tools either always failed for a buyer's per-user OAuth token (third-party listing reads → `access_denied`), were decommissioned by Mercado Libre, or were superseded — and none are used by the buyer or seller skills. Keeping them only invited the agent to call dead endpoints. Removed:

- `get_item`, `get_items_bulk`, `get_item_shipping_options`, `get_item_sale_terms` — third-party listing reads are `access_denied` for buyers.
- `compare_products` — built on `get_items_bulk` (same block).
- `search_listings`, `search_listings_by_seller` — `GET /sites/{site}/search` is blocked for these apps.
- `get_product_listings` — decommissioned by ML on 2025-10-01 (always empty).
- `search_buyable_listings` — legacy alias of `find_offers_for_product_query`.

**Use instead:** `find_offers_for_product_query` (offers + prices + permalinks, api/web), `get_product` / `get_product_buybox` (catalog datasheet + buy box), `rank_sellers_for_query` (merchants + live prices), `get_item_reviews` (with scraped fallback). Seller flows are unaffected (`seller_*` tools). `FindOffersForProductQueryParams` is now a standalone interface (was an alias of the removed `SearchBuyableListingsParams`).

## 1.9.5

### Remove `get_seller_response_time` (buyer-inaccessible)

`GET /users/{id}/questions/response_time` is **seller-private**: a buyer's OAuth token always gets `403 forbidden` ("User X cannot access data for user Y"), so the tool could never answer "does this seller reply quickly?". The metric isn't exposed by ML's public API or recoverable via the scraper (the actor's seller mode returns only the storefront catalog), so the tool is removed rather than left as a guaranteed failure. Seller trust signals still come from `get_seller_info` (reputation, level, sales, claims) and `rank_sellers_for_query`.

## 1.9.4

### Web offers from website search (fixes niche/new models, e.g. MacBook Air M4)

`find_offers_for_product_query` enriched prices by scraping the **catalog API's** product matches. For niche or just-released models the catalog API (`/products/search`) returns the wrong/older variants (e.g. MacBook Pro 14 / Air M2 for "MacBook Air M4"), so the per-`/p`-page scrapes found no price and timed out — the user got "no price available" even though active listings existed.

- **Web enrichment is now sourced from a single website-**search** scrape** (the same ranking a shopper sees) instead of N per-product-page scrapes of the catalog API's matches. This is one fast run (~10s) and returns the *right* listings with prices + permalinks.
- **Best-effort seller/installments enrichment**: the top `scrape_limit` search hits are enriched with a product-mode scrape (bounded by `WEB_DETAIL_TIMEOUT_MS`, default 20s) to recover seller, installments, condition and shipping. If a product page is slow/blocked, the offer **degrades gracefully** to the search hit's price + permalink instead of failing the call.
- Results are filtered for relevance against the query and to the `price_min`/`price_max` window; every web offer keeps `price_source: "web"` and a clickable `permalink`.
- New env `WEB_DETAIL_TIMEOUT_MS` (default 20000).

## 1.9.3

### Parallel web price scraping (fixes MCP call timeout)

Sequential scraping of no-buy-box catalog products (each browser scrape is 15-30s) exceeded the MCP gateway's tool-call timeout, so `find_offers_for_product_query` timed out instead of returning prices.

- **Scrapes now run in parallel** (`Promise.all`), so wall time ≈ a single scrape regardless of `scrape_limit` (still default 3).
- **`APIFY_TIMEOUT_MS` default raised 35s → 45s.** Keep it strictly below the MCP gateway (Bifrost) tool-execution timeout — recommended Bifrost = 60s, leaving room for the catalog scan (`catalog ~8-10s + scrape 45s < 60s`). A slow scrape now self-aborts and falls into `catalog_without_price` (served from the 10-min cache next call) rather than killing the whole tool call.
- `scrapeProduct` accepts an optional per-call `timeoutMs`.

## 1.9.2

### Fix: treat a scraped price of 0 as "no price"

Some product pages return `price: 0` (no real offer). The scraper now treats non-positive prices as missing for both `scrapeProduct` and `scrapeSearch`, so offers never surface a bogus `$0`.

## 1.9.1

### Fix: web price enrichment skipped when catalog permalink is empty

The catalog API returns an empty `permalink` for many no-buy-box products (e.g. basic phones), so `find_offers_for_product_query` and `get_product_buybox` skipped web price enrichment entirely and fell back to `catalog_without_price`. They now synthesize the canonical `/p/{catalog_product_id}` URL when the API gives no permalink and scrape that, so prices come through.

## 1.9.0

### Web price enrichment via Apify (no agent browser)

Mercado Libre's catalog API returns no price for products without an active buy-box winner (iPhone, MacBook, refurbished), and ML blocks plain HTTP scraping. The server now recovers the **live website price** deterministically by calling an Apify Mercado Libre actor (real browser + residential proxies) and merging it into tool responses — so buyer agents no longer need to drive a browser.

- **New module `src/apify-scraper.ts`** — `ScraperProvider` interface + `ApifyScraper` implementation (modes: product, search, seller, reviews). Fails soft (missing token / timeout / non-2xx / empty → no enrichment, never throws), TTL-cached, bounded, and behind a swappable interface. Process-wide singleton via `getScraper()`.
- **`find_offers_for_product_query`** — no-buy-box catalog matches are priced from the web and promoted into `offers[]`. Every offer now carries **`price_source`** (`"api"` or `"web"`). New `scrape_limit` param (default 3, max 5; 0 disables). Adds `web_enriched_count`.
- **`get_product_buybox`** — returns `web_offer` (price_source `web`) when there is no API buy-box winner. New optional `site_id`.
- **`search_items`** — new `include_web_prices` → adds `web_offers[]` with live prices (catalog search otherwise returns price-less ids).
- **`rank_sellers_for_query`** — adds `web_ranked_sellers[]` (sellers + cheapest live price), reliable even when official seller-inventory endpoints are blocked. New `include_web_offers` (default true when scraper configured).
- **`get_seller_info`** — new `include_catalog` → adds `web_storefront` (seller's live catalog + reputation). New optional `site_id`.
- **`get_item_reviews`** — falls back to scraped web reviews (`reviews_source: "web"`) when the official API is empty.
- **Config** — `APIFY_TOKEN` (enables enrichment; one shared server token, not per-user / not in Bifrost), `APIFY_ML_ACTOR` (default `sourabhbgp~mercadolibre-scraper`), `APIFY_TIMEOUT_MS`, `SCRAPE_LIMIT`, `SCRAPE_CACHE_TTL_MS`.
- Tests: `tests/apify-scraper.test.ts` covers the adapter (normalize, no-price, non-2xx, throw, cache) and the enrichment branches.

## 1.8.0

### Merchant discovery without `/sites/search?q=`

- **Removed `search_listings` MCP tool** — `GET /sites/{site}/search?q=` is not the documented buyer path and returns 403 for this app. The programmatic helper still returns a deprecation payload pointing at `rank_sellers_for_query`.
- **`rank_sellers_for_query` rewritten** — new strategy `domain_catalog_category_sellers`: `domain_discovery` → `products/search` in domain → buy-box sellers + best-effort category listing scan → reputation rank → top N sellers' active inventory via `GET /users/{seller_id}/items/search` filtered by query tokens. Returns `top_sellers[].listings[]` with prices per merchant.
- **`search_listings_by_seller`** — now uses `GET /users/{seller_id}/items/search` + multiget instead of `/sites/search?seller_id=`.
- Tool descriptions updated to stop referencing `search_listings`.

## 1.7.0

### Buyer product-query tools

- **`find_offers_for_product_query`** — product-scoped discovery for "I want to buy X": `GET /products/search` → buy box → listing + optional seller reputation. Returns `offers` (priced when buy box exists) and **`catalog_without_price`** (permalink + specs path when `buy_box_winner` is null) so agents stop silently dropping MacBook-style catalog hits.
- **`rank_sellers_for_query`** — "top N merchants for product query": `GET /sites/search?q=` → dedupe sellers → reputation score → example listing price. On 403, returns structured fallback pointing at `find_offers_for_product_query` (not category `/highlights` bestsellers).
- **`search_buyable_listings`** — now a legacy alias of `find_offers_for_product_query` (still returns `listings` / `matched_count` for backward compatibility).
- **`search_listings`** — 403 blocked payloads now surface as **`isError: true`** in MCP tool results; fallback hints updated to new tool names.

## 1.6.6

### Docs / tool guidance (no behaviour change to API calls)

Catalog price discovery was steering the agent to dead/empty endpoints, so users never got prices even after auth was fixed. Realigned tool descriptions and result notes to MercadoLibre's current catalog reality:

- **`get_product_listings`** (`GET /products/{id}/items`) — ML **decommissioned this on 2025-10-01**; it now returns empty. Description and `deprecation_note` updated to say so and to point at `search_listings`.
- **`search_listings`** (`GET /sites/{site}/search?q=`) — promoted to the **primary price tool**. ML returns `403 forbidden` only for *unauthenticated* calls (per the April-2025 policy change); with a user token it returns live listings + prices. Description clarifies that a 403 *with* a token is an app IP-allowlist / app-block issue, not a wrong tool. The 403 fallback payload now explains this instead of implying the catalog workaround is equivalent.
- **`get_product_buybox`** — note now states `buy_box_winner` already carries the price, and that a null winner means the catalog page has no price (→ use `search_listings`). Stops suggesting the decommissioned `get_product_listings`.
- **`search_items` / `get_items_bulk`** — descriptions now state explicitly that `search_items` returns **catalog product ids** which are NOT listing ids and must never be passed to `get_item`/`get_items_bulk` (the latter 404s on catalog ids). This was causing the agent's `404 not_found` on bulk fetches.

## 1.6.5

### Fixes

- **Per-user OAuth token was dropped for most tools, causing Mercado Libre `401 "authorization value not present"`.** The token travels via `AsyncLocalStorage`: the outer `wrapToolWithRequestTokenContext` wrapper sets it from the request's `Authorization` header for every tool, but `toolResult`'s inner `runWithRequestAccessToken(token, handler)` re-wrapped with `token = extra ? resolveBearerToken(extra) : undefined`. Any tool registered as `toolResult(() => tools.x(params))` **without** forwarding `extra` therefore re-ran its handler in a fresh context with `accessToken = undefined`, clobbering the real token. Only `search_items`, `search_buyable_listings`, and `get_me` forwarded `extra`, so e.g. `get_product_buybox`, `get_product`, `get_item`, `get_seller_info`, and the order/claim/question tools called ML with no `Authorization` header. The buyer and seller `toolResult` wrappers now resolve the token as `fromExtra ?? getRequestAccessToken()`, inheriting the active request token instead of overwriting it with `undefined`. New `getRequestAccessToken()` accessor added in `client.ts`; regression tests added in `tests/client.test.ts`.

## 1.6.4

Fix the second-request 500 introduced by sharing one `StreamableHTTPServerTransport` across requests. The SDK keeps `_initialized` and request-bookkeeping maps on instance state; in stateless mode each HTTP request needs its own `McpServer + transport`, constructed inside the request handler. Moves the construction inside the `/meli/mcp` branch.

Also wires `transport.onerror` to log SDK-internal errors as `msg: "mcp_transport_error"` on stderr, complementing the existing `mcp_handle_request_threw` and `http_request` lines. Together they cover the three failure surfaces: our `try/catch`, the SDK's internal error callback, and the final HTTP status (even when hono swallows the throw).

Per-request cost is the McpServer construction + 77 tool registrations — small (≤ tens of ms) compared to a real MercadoLibre round-trip.

## 1.6.3

Diagnostic ship. Adds HTTP-level request logging to `src/cli.ts` so we can see when 1.6.2's tool-level error logger doesn't fire — the SDK's `StreamableHTTPServerTransport` uses `@hono/node-server`'s `getRequestListener`, which catches internal throws and writes its own 500 before our `try/catch` can see them. After 1.6.3, every request emits one JSON line on stderr with `msg: "http_request"`, `level` derived from status (`info`/`warn`/`error`), `method`, `url`, `status`, `duration_ms`. If a throw does reach our catch, a second `msg: "mcp_handle_request_threw"` line is emitted with the error message + stack.

Strictly diagnostic — no behavior change, no API change. Plan to dial back the always-on request logging once the Bifrost ↔ mcp-meli wire is verified.

## 1.6.2

Replaces the `MELI_AUTH_TRACE` debug flag with **always-on structured error logs** — one JSON line per failed tool call on stderr with `level: "error"` (ClickStack / OTel collectors map to `SeverityText=ERROR`).

Each error carries the inbound auth context (token source / prefix / fingerprint), the inbound MCP headers with sensitive ones redacted (`Authorization`, `Cookie`, `Proxy-Authorization`, `X-Amz-Security-Token`), and the MercadoLibre method / path / status / response headers / response body. `traceparent` survives redaction so pod logs can be joined with Bifrost / OTel traces.

Verbose by design for the per-user OAuth rollout — silent on success, structured JSON on failure. stdout stays clean for the MCP JSON-RPC wire stream (stdio transport safety).

## 1.6.1

`MELI_AUTH_TRACE=1` no longer mutates tool-result payloads — the `[AUTH_TRACE] inbound_source=… outbound_last=…` line is now emitted to stdout only, instead of being prepended to `content[0].text` of every response. This makes the debug flag safe to leave enabled in production: response shape is identical whether the flag is on or off.

### Fixes

- `src/mcp-tools.ts:43-66` and `src/mcp-seller-tools.ts:77-108` — extract the trace summary into a `logTraceSummary()` helper that calls `console.log` directly. The success and error branches of `toolResult()` no longer concatenate a `[AUTH_TRACE] …` prefix into the returned text. Tools that always emit JSON `result` payloads now produce strict JSON regardless of `MELI_AUTH_TRACE`.
- Internal trace events (`[MELI_AUTH_TRACE] tool_result prefix=… fp=…`, `[MELI_AUTH_TRACE] effective_token_selected …`) are unchanged — they were already stdout-only.

### Operational impact

`kubectl logs` is the single channel for auth tracing now. Clients parsing `result.content[0].text` as JSON (or as a strict tool-result type) will no longer break under the debug flag.

## 1.6.0

Per-user OAuth release — the MCP server now speaks Streamable HTTP natively and propagates `Authorization: Bearer` headers from each inbound request into the underlying MercadoLibre API call.

### Breaking

- **Container ENTRYPOINT changed from `mcp-proxy` to `node bin/mcp-server.mjs`.** The TBXark/mcp-proxy stdio→HTTP bridge has been removed from the image; the server speaks Streamable HTTP directly. Bifrost's existing client config (URL `…:8000/meli/mcp`) is unchanged. Anyone overriding `/etc/mcp-proxy/config.json` at runtime should remove that mount — the file no longer exists.
- **Removed `config/mcp-proxy.docker.json` and `config/mcp-proxy.example.json`** from the repo.
- **Dropped the `bridge-builder` (Go / TBXark/mcp-proxy) stage from the Dockerfile.** Build is now single Node stage plus a runtime stage.

### Auth — per-user OAuth via Bifrost

- New transport: **Streamable HTTP** (`@modelcontextprotocol/sdk/server/streamableHttp.js`) on `:$PORT/meli/mcp` (defaults `:8000/meli/mcp`). Stateless mode (`sessionIdGenerator: undefined`) — each HTTP request is self-contained. The MCP endpoint path is a hardcoded constant since Bifrost has it baked into its client config.
- `bin/mcp-server.mjs` now accepts `--transport stdio|http`; the published `mercadolibre-mcp` / `meli-mcp` binaries default to stdio for npx use (Claude Desktop, Cursor, Inspector). The Docker image bakes `--transport http` into its ENTRYPOINT so production runs HTTP without code change.
- Inbound `Authorization: Bearer <token>` is read in each MCP tool handler from `extra.requestInfo.headers.authorization` (only populated when the transport is HTTP), then scoped per-request via `AsyncLocalStorage` so concurrent users' tokens never cross-contaminate.
- Falls back to `MERCADOLIBRE_ACCESS_TOKEN` env var when no inbound bearer is present (preserves the service-account / cron use case).
- Optional debug instrumentation: set `MELI_AUTH_TRACE=1` to surface redacted token-source / fingerprint in tool responses and stdout for end-to-end verification.

### Why this matters

TBXark/mcp-proxy does not forward inbound HTTP headers to the wrapped stdio MCP server (see [TBXark/mcp-proxy#45](https://github.com/TBXark/mcp-proxy/issues/45) — closed without merging the `ForwardHeaders` patch). With the proxy in the path, Bifrost's per-user `Authorization: Bearer` headers were silently dropped, and every user effectively shared whichever static token the Deployment had been provisioned with. Speaking Streamable HTTP directly closes that gap: `requestInfo.headers.authorization` is populated by the SDK from the inbound HTTP request, end of story.

### Bifrost compatibility

Bifrost's MCP client config (`auth_type: per_user_oauth`, `oauth_config_id: …`) works unchanged. The same URL `http://mcp-meli.<ns>.svc.cluster.local:8000/meli/mcp` still answers — just from `node` instead of `mcp-proxy`. Use the regional `auth.mercadolibre.com.<region>/authorization` endpoint and the global `api.mercadolibre.com/oauth/token` endpoint. MercadoLibre OAuth supports refresh-token rotation (single-use) and PKCE S256 (opt-in at the app level); enabling PKCE on the registered MercadoLibre app is recommended.

### Operational notes

- **Healthcheck**: HTTP transport exposes `GET /healthz` (200 / `ok`) for K8s probes. The previous `tcpSocket: 8000` probes still work.
- **Graceful shutdown**: `SIGTERM` triggers `http.Server.close()` with a 10s drain timeout before `process.exit`.
- **Per-tool-call cost**: AsyncLocalStorage scope-wrap is negligible (~µs). Per-request token resolution is O(1) header parse.

## 1.4.0

Toolchain modernization release — Node 24 + pnpm 11, major dependency bumps, and zero open vulnerabilities. Behavior of the 77 MCP tools is unchanged.

### Breaking

- **Node.js `>=24`** (was `>=18`). Node 18 (EOL April 2025) and Node 20 (EOL April 2026) are no longer supported. CI runs on Node 24; the Docker base image is `node:24.16.0-alpine3.23`.
- **`zod` upgraded from 3.x to 4.x.** Exported parameter types (e.g. `SearchItemsParams`, `SellerCreateListingParams`) are now inferred via zod 4, which changes a few subtle behaviors at the validation layer. Programmatic consumers should bump their own `zod` to `^4` to share a single resolved version.
- **`mcp-proxy.docker.json`**: the embedded server config now sets `panicIfInvalid: true` — the proxy refuses to start when the MCP server config is invalid instead of running in a degraded state. Operators who relied on the proxy starting anyway should validate their config first.

### Security

- **0 known vulnerabilities** (`pnpm audit` / `npm audit` clean).
- Fixed 14 advisories that were open against 1.3.0 — 2 high (`fast-uri`, `path-to-regexp`) and 12 moderate (`hono`, `qs`, `ip-address`, `esbuild`, `postcss`, `brace-expansion`, etc.). All traced to two roots: an out-of-date MCP SDK (1.27.1 → 1.29.0) and an out-of-date test stack (vitest 1.6.1 → 4.1.7).
- Adopted **pnpm 11's tightened defaults** for supply-chain safety: `minimumReleaseAge: 1440` (24h quarantine on freshly published versions), `strictDepBuilds: true` (lifecycle scripts refused unless allowlisted), `blockExoticSubdeps: true` (blocks transitive git/file refs).

### Toolchain (dev / CI)

- **Migrated from npm to pnpm 11.4.0**, pinned via `"packageManager": "pnpm@11.4.0"` in `package.json`.
- `package-lock.json` replaced by `pnpm-lock.yaml`. The new lockfile records cross-platform optional dependencies correctly, fixing a latent class of Docker-build failures where `npm ci` rejected the host-generated lockfile on Linux due to missing `@emnapi/core` etc.
- Single-package `pnpm-workspace.yaml` added so `pnpm deploy --legacy --prod /prod` can produce a self-contained runtime tree.
- **CI workflow** rewritten: `pnpm/action-setup@v4` + `actions/setup-node@v4` with `cache: pnpm`; runs `pnpm install --frozen-lockfile && pnpm test && pnpm build && pnpm exec tsc --noEmit` on Node 24.
- **Dependency bumps**:
  - `@modelcontextprotocol/sdk` 1.27.1 → 1.29.0
  - `typescript` 5.4 → 6.0.3 (major)
  - `vitest` + `@vitest/coverage-v8` 1.6.1 → 4.1.7 (three major versions)

### Runtime / Docker

- **Dockerfile rewrite** around pnpm:
  - Stage 1 installs pnpm via `npm install -g pnpm@11.4.0` (no corepack reliance — corepack is `experimental` in current Node and on track to be removed from core).
  - BuildKit cache mounts on the pnpm store make repeat builds near-instant.
  - `pnpm deploy --legacy --filter=@kolmena-ai/meli-mcp --prod /prod` produces a self-contained prod tree with no symlinks back to the pnpm store.
  - Stage 3 is a straight `COPY --from=build /prod /app` — no second install in the runtime stage.
- **`.dockerignore` added** — filters `node_modules`, `dist`, `coverage`, `.git`, `.idea`, `tests`, `.env*`. Stops host artifacts from leaking into the build context.
- Final image size unchanged (~184 MB, Node base layer dominates).

### Fixes

- `src/mcp-seller-tools.ts:411` — `seller_submit_claim_action` `payload` schema updated from `z.record(valueSchema)` (zod 3) to `z.record(z.string(), valueSchema)` (zod 4 requires explicit key schema).
- Restored `zod` to `dependencies` after it was briefly moved to `devDependencies` — `src/mcp-tools.ts` imports it at runtime and `pnpm deploy --prod` would otherwise ship a broken package.

## 1.3.0

First release under the `@kolmena-ai/` scope. Fork of [`@dan1d/mercadolibre-mcp@1.0.2`](https://www.npmjs.com/package/@dan1d/mercadolibre-mcp) (8 buyer tools) expanded to **77 tools** (36 buyer + 41 seller).

### Buyer

- **Catalog search rewrite** — `search_items` now hits `GET /products/search` (token-bound) instead of the upstream `GET /sites/{site}/search?q=` which started returning 403 for many apps. Response is wrapped with `search_api` / `result_type: catalog_product` so callers can tell which API answered.
- **Catalog fallback** — `get_item` and `get_item_description` fall back to `GET /products/{id}` when `/items/{id}` returns 404, so catalog ids returned by `search_items` (e.g. `MLA55016525`) work without an extra round trip.
- **`get_product`** — explicit `GET /products/{id}` for catalog datasheets.
- **Buyer suite (27 new tools)** — compare, reviews, shipping, Q&A, orders, shipments, claims, domain discovery, official stores, seller response time, etc.
- **`search_buyable_listings`** — composite workaround for the blocked legacy search: catalog → buy box → price filter → optional seller reputation. Use this for "listings under $X with seller ratings" workflows.
- **`search_listings`** — still tries the legacy endpoint; on 403 returns a structured fallback hint pointing at `search_buyable_listings`.
- **`compare_products`** — bulk compare with optional reviews and shipping.
- Most buyer / post-purchase calls now require `MERCADOLIBRE_ACCESS_TOKEN`.

### Seller (new in this fork)

- **41 `seller_*` tools** — store snapshot, listings audit, inventory, orders, shipments, Q&A, promotions, messages, claims, feedback. Full mapping in [SELLER-API-ROADMAP.md](./SELLER-API-ROADMAP.md).
- **Listing creation** — `seller_get_listing_requirements`, `seller_upload_listing_picture`, `seller_validate_listing`, `seller_create_listing`.
- **Ownership checks** on `seller_get_my_item`, `seller_get_order`, and bulk variants — synthetic 403 if the token doesn't match `seller_id`.

### Client / infrastructure

- **`MercadoLibreClient`** gains `postJson`, `postValidate` (204 / 400 discriminated union for `/items/validate`), `postMultipart` (picture upload), and HTTP `PUT` for listing updates.
- Package renamed to `@kolmena-ai/meli-mcp`; binaries `mercadolibre-mcp` and `meli-mcp` share the same entrypoint.
- Local dev: `pnpm inspector` / `inspector:auth` for MCP Inspector, `pnpm smoke` for CLI smoke of every tool, see [TESTING.md](./TESTING.md).
- Kolmena backend: `meli-buyer` + `meli-seller` skills consume this MCP via `CALL_MCP_TOOL`; the old `meli-api` skill is deprecated.
