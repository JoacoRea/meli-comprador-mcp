# Fork

Fork of [KolmenaAI/mercadolibre-mcp](https://github.com/KolmenaAI/mercadolibre-mcp) (`@kolmena-ai/meli-mcp@1.10.6`), itself a fork of [dan1d/mercadolibre-mcp](https://github.com/dan1d/mercadolibre-mcp).

## What changed vs Kolmena 1.10.6

- Only 9 read-only buyer tools (see README). All `seller_*`, `ask_seller_question`, post-purchase, category/domain/trend/currency tools removed. `MercadoLibreClient` is GET-only.
- Auto-refreshing OAuth tokens (`src/token-manager.ts`, `pnpm auth` → `src/auth-cli.ts`).
- Apify token sent as a header instead of a query parameter.

## Sync from upstream

```bash
git remote add upstream https://github.com/KolmenaAI/mercadolibre-mcp.git
git fetch upstream
git cherry-pick <commit>   # buyer/scraper fixes only; never re-add write tools
pnpm install && pnpm build && pnpm test
```

`tests/mcp-server.test.ts` fails if a merge brings back any tool outside the allowed 9.
