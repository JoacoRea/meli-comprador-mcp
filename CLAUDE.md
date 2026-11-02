# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Read-only **buyer** MCP for Mercado Libre: a fork of `@kolmena-ai/meli-mcp` (itself a fork of `@dan1d/mercadolibre-mcp`) cut down to **9 tools** (see README). Nothing may write to Mercado Libre — no questions, cart, purchases, or seller actions. `tests/mcp-server.test.ts` asserts the exact tool list; changing it is a deliberate, reviewed decision.

## Commands

```bash
pnpm build                 # tsc → dist/ (required before running bin/)
pnpm test                  # vitest run
pnpm exec tsc --noEmit     # type-check only
pnpm exec vitest run tests/token-manager.test.ts   # single file
pnpm auth                  # one-time OAuth authorization (writes token store)
pnpm start                 # node bin/mcp-server.mjs (stdio)
pnpm inspector             # MCP Inspector UI
```

CI (`.github/workflows/ci.yml`) runs install, test, build and `tsc --noEmit` on Node 24.

## Architecture

```
bin/mcp-server.mjs        # shim → dist/cli.js
src/cli.ts                # stdio (default) or --transport http; builds TokenManager from env
src/mcp-server.ts         # McpServer + registerMercadoLibreTools
src/mcp-tools.ts          # the 9 tool registrations (zod shape → toolResult(handler))
src/index.ts              # createMercadoLibreTools(auth) + BUYER_READONLY_TOOLS
src/client.ts             # GET-only MercadoLibreClient; inbound-token AsyncLocalStorage; 401 → refresh+retry once
src/token-manager.ts      # TokenManager, FileTokenStore (lock file), requestToken (/oauth/token)
src/auth-cli.ts           # `pnpm auth` authorization_code flow (PKCE S256, state)
src/actions.ts, src/buyer-actions.ts   # action implementations (some unexposed read-only helpers remain as SDK exports)
src/apify-scraper.ts      # optional web enrichment; disabled without APIFY_TOKEN, fails soft
```

### Adding or changing a tool

Touchpoints: schema (`schemas.ts` / `buyer-schemas.ts`), action, factory in `src/index.ts` + `BUYER_READONLY_TOOLS`, registration in `src/mcp-tools.ts` wrapped in `toolResult()`, and the hard-coded list in `tests/mcp-server.test.ts`. Never add a tool that sends anything other than GET to `api.mercadolibre.com`.

### Auth

Token priority per call: inbound `Authorization: Bearer` (HTTP mode) > token store (`~/.config/meli-comprador-mcp/tokens.json`, `MELI_TOKEN_STORE`) > `MERCADOLIBRE_ACCESS_TOKEN`. The refresh token is single-use: every refresh must persist the new one. Renewal is serialized in-process (`inflight` promise) and across processes (`tokens.json.lock`). Never log token values — logs go to stderr (stdout is the stdio JSON-RPC channel).

### Catalog vs listing ids

`search_items` uses `/products/search` and returns **catalog product ids**; `/items/{id}` 404s on them. `get_item_description` falls back to `/products/{id}` (`product-helpers.ts`). For a single listing id, `get_listing_offer` reads the website via Apify.

## TypeScript

`module: Node16` ESM; import local files as `./foo.js`. Tests in `tests/` are excluded from `tsconfig.json` and mock `fetch` per suite.
