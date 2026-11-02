/**
 * `pnpm auth` — one-time MercadoLibre OAuth authorization.
 *
 * 1. Opens https://auth.mercadolibre.com.ar/authorization (PKCE S256 unless
 *    MELI_PKCE=false) in the browser.
 * 2. Gets the `code`: if MELI_REDIRECT_URI is http://localhost:<port>/… a
 *    local server captures it; otherwise paste the full URL the browser was
 *    redirected to (or just the code).
 * 3. Exchanges it at /oauth/token and writes the token store
 *    (default ~/.config/meli-comprador-mcp/tokens.json).
 *
 * Reads MELI_CLIENT_ID, MELI_CLIENT_SECRET, MELI_REDIRECT_URI from env or
 * ~/.config/meli-comprador-mcp/config.env (see env-file.ts).
 * Never prints tokens or the client secret.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { createInterface } from "node:readline/promises";
import { loadEnvFile } from "./env-file.js";
import { FileTokenStore, defaultTokenStorePath, requestToken } from "./token-manager.js";

const AUTH_BASE = process.env.MELI_AUTH_URL || "https://auth.mercadolibre.com.ar/authorization";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // The URL is printed too; opening is best-effort.
  }
}

/** Accepts a full redirect URL or a bare code. */
export function parseAuthorizationResponse(
  input: string,
  expectedState: string
): string {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  const url = new URL(trimmed);
  const error = url.searchParams.get("error");
  if (error) throw new Error(`Authorization denied: ${error}`);
  const state = url.searchParams.get("state");
  if (state !== expectedState) throw new Error("State mismatch — start `pnpm auth` again.");
  const code = url.searchParams.get("code");
  if (!code) throw new Error("No `code` parameter in that URL.");
  return code;
}

function waitForLocalCallback(redirect: URL, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", redirect);
      if (reqUrl.pathname !== redirect.pathname) {
        res.statusCode = 404;
        res.end();
        return;
      }
      try {
        const code = parseAuthorizationResponse(reqUrl.toString(), expectedState);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Listo. Ya podés cerrar esta pestaña y volver a la terminal.");
        server.close();
        resolve(code);
      } catch (error) {
        res.statusCode = 400;
        res.end(error instanceof Error ? error.message : String(error));
        server.close();
        reject(error);
      }
    });
    server.on("error", reject);
    server.listen(Number(redirect.port || 80), redirect.hostname);
  });
}

export async function runAuth(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const clientId = env.MELI_CLIENT_ID;
  const clientSecret = env.MELI_CLIENT_SECRET;
  const redirectUri = env.MELI_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Set MELI_CLIENT_ID, MELI_CLIENT_SECRET and MELI_REDIRECT_URI before running `pnpm auth`.");
  }

  const usePkce = env.MELI_PKCE !== "false";
  const state = base64url(randomBytes(16));
  const verifier = base64url(randomBytes(48));
  const authUrl = new URL(AUTH_BASE);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  if (usePkce) {
    authUrl.searchParams.set("code_challenge", base64url(createHash("sha256").update(verifier).digest()));
    authUrl.searchParams.set("code_challenge_method", "S256");
  }

  const redirect = new URL(redirectUri);
  const localCallback =
    redirect.protocol === "http:" && ["localhost", "127.0.0.1"].includes(redirect.hostname);

  console.log("Abrí esta URL, iniciá sesión en Mercado Libre y autorizá la app:\n");
  console.log(authUrl.toString() + "\n");

  let code: string;
  if (localCallback) {
    const pending = waitForLocalCallback(redirect, state);
    openBrowser(authUrl.toString());
    console.log(`Esperando la redirección en ${redirect.origin}${redirect.pathname} …`);
    code = await pending;
  } else {
    openBrowser(authUrl.toString());
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        "Después de autorizar, pegá acá la URL completa a la que te redirigió el navegador (o solo el code):\n> "
      );
      code = parseAuthorizationResponse(answer, state);
    } finally {
      rl.close();
    }
  }

  const tokens = await requestToken({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    ...(usePkce ? { code_verifier: verifier } : {}),
  });
  if (!tokens.refresh_token) {
    throw new Error(
      "ML did not return a refresh_token. Enable the 'Refresh Token' OAuth flow in your app settings and run `pnpm auth` again."
    );
  }

  const storePath = defaultTokenStorePath(env);
  await new FileTokenStore(storePath).save({ ...tokens, refresh_token: tokens.refresh_token });
  console.log(`\nAutorizado (user_id ${tokens.user_id ?? "?"}). Tokens guardados en ${storePath}`);
  console.log(`El access token vence ${new Date(tokens.expires_at).toLocaleString()} y se renueva solo.`);
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("/auth-cli.js");
if (invokedDirectly) {
  loadEnvFile();
  runAuth().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
