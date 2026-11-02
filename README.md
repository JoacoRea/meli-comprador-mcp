# meli-comprador-mcp

MCP de **Mercado Libre para comprador, solo lectura**. Busca y compara productos, lee publicaciones, reseñas, reputación del vendedor y preguntas. No escribe nada en Mercado Libre: no pregunta al vendedor, no toca el carrito, no compra.

Es un fork de [KolmenaAI/mercadolibre-mcp](https://github.com/KolmenaAI/mercadolibre-mcp), que a su vez es un fork de [dan1d/mercadolibre-mcp](https://github.com/dan1d/mercadolibre-mcp). Se mantiene su búsqueda por catálogo y el enriquecimiento por scraping vía Apify. Este fork agrega renovación automática del token de ML.

## Tools

| Grupo | Tools |
| --- | --- |
| Buscar y ofertas | `search_items`, `find_offers_for_product_query`, `get_product`, `get_product_buybox` |
| Leer publicación | `get_listing_offer` |
| Reseñas y vendedor | `get_item_description`, `get_item_reviews`, `get_seller_info` |
| Preguntas | `get_item_questions` |

Son exactamente estas 9: un test (`tests/mcp-server.test.ts`) falla si se registra cualquier otra.

Notas:
- `search_items` devuelve ids de **catálogo** (`MLA62309973`), no de publicación. La API de ML cerró la búsqueda abierta de publicaciones.
- `get_listing_offer` lee una publicación suelta (`MLA4036036738` o su URL) desde la web. Necesita `APIFY_TOKEN`.

## Instalación

Requiere Node 24+ y pnpm.

```bash
pnpm install
pnpm build
pnpm test
```

## Autorizar Mercado Libre (una sola vez)

1. Creá una app en [developers.mercadolibre.com.ar](https://developers.mercadolibre.com.ar/devcenter) con:
   - **Redirect URI**: `https://example.com/meli-callback`. ML exige `https://` con un dominio público (rechaza `localhost`). Tiene que coincidir **exactamente** con `MELI_REDIRECT_URI`.
   - **Flujos OAuth**: `Authorization Code` y `Refresh Token` (sin este último ML no devuelve refresh token). `Client Credentials` no hace falta.
   - **PKCE**: activado. **Negocios**: Mercado Libre. **Permisos**: Usuarios en lectura (o lo que venga fijo); el resto "Sin acceso". **Tópicos**: ninguno.
2. Definí las variables en tu terminal. No las pegues en ningún chat.
3. Corré:

   ```bash
   pnpm auth
   ```

   Se abre el navegador. Iniciá sesión y autorizá. ML te redirige a `https://example.com/meli-callback?code=…&state=…` y ves la página "Example Domain". Copiá la URL completa de la barra de direcciones y pegala en la terminal.

   Usar `example.com` es seguro: el `code` es de un solo uso y no sirve sin tu `client_secret` y el verificador PKCE, que nunca salen de tu máquina. Si tenés un dominio propio, podés usarlo igual.

Los tokens se guardan en `~/.config/meli-comprador-mcp/tokens.json`, fuera del repo. En Windows es `%USERPROFILE%\.config\meli-comprador-mcp\tokens.json`.

### Renovación automática

- El access token de ML dura unas horas. Si vence en menos de 5 minutos, el MCP lo renueva antes de la llamada.
- El refresh token es de **un solo uso**. Cada renovación guarda el nuevo.
- Si ML responde 401, el MCP renueva y reintenta **una sola vez**.
- La renovación se serializa, también entre varios procesos (por ejemplo, varias sesiones de Claude Code). Así un refresh token no se gasta dos veces.
- Si ML rechaza el refresh token (`invalid_grant`), corré `pnpm auth` de nuevo. Pasa si se revocó o si no usaste la app en meses.

Orden de prioridad del token:
1. Header `Authorization: Bearer` entrante (modo HTTP).
2. Token store.
3. `MERCADOLIBRE_ACCESS_TOKEN`.

## Variables de entorno

| Variable | Para qué |
| --- | --- |
| `MELI_CLIENT_ID`, `MELI_CLIENT_SECRET` | App de ML. Necesarias para `pnpm auth` y para renovar. |
| `MELI_REDIRECT_URI` | Igual a la Redirect URI configurada en la app. |
| `MELI_TOKEN_STORE` | Opcional. Otra ruta para `tokens.json`. |
| `MELI_PKCE` | Opcional. Ponela en `false` si tu app no tiene PKCE y `pnpm auth` falla. |
| `MERCADOLIBRE_ACCESS_TOKEN` | Opcional. Token fijo de respaldo, solo si el store está vacío. No se renueva. |
| `APIFY_TOKEN` | Opcional. Activa los precios y reseñas por scraping, y `get_listing_offer`. Sin él, todo degrada sin error. |
| `SCRAPE_LIMIT` | Productos a enriquecer por consulta (default `3`, máx `5`). Cuida el crédito de Apify. |
| `SCRAPE_CACHE_TTL_MS` | Cache en memoria de scrapes (default 10 min). |

Ver `.env.example`.

## Registrar en Claude Code

```bash
claude mcp add mercadolibre --scope user \
  -e MELI_CLIENT_ID=... -e MELI_CLIENT_SECRET=... -e MELI_REDIRECT_URI=... \
  -e APIFY_TOKEN=... \
  -- node "C:\RUTA\A\meli-comprador-mcp\bin\mcp-server.mjs"
claude mcp list
```

El modo por defecto es stdio. Para HTTP: `node bin/mcp-server.mjs --transport http`, que sirve `POST /meli/mcp` en `$PORT` (default 8000).

## Créditos y licencia

MIT. Código original de [dan1d](https://github.com/dan1d/mercadolibre-mcp), extendido por [KolmenaAI](https://github.com/KolmenaAI/mercadolibre-mcp). Ver `LICENSE`.
