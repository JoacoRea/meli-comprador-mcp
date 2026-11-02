/**
 * Auto-refreshing MercadoLibre OAuth tokens.
 *
 * ML access tokens last a few hours (`expires_in`, seconds). The refresh
 * token is single-use: every refresh returns a NEW refresh token that must
 * be persisted, or the next refresh fails with `invalid_grant`.
 *
 * Tokens live in a JSON file outside the repo (default
 * `~/.config/meli-comprador-mcp/tokens.json`, override with
 * MELI_TOKEN_STORE). Renewal is serialized inside the process (one
 * in-flight refresh shared by concurrent callers) and across processes
 * (a `.lock` file next to the store), because several MCP processes —
 * e.g. multiple Claude Code sessions — can share one store.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccessTokenProvider } from "./client.js";

export const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";

/** Refresh when the access token expires in less than this. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 100;

export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds. */
  expires_at: number;
  user_id?: number;
  scope?: string;
}

export interface TokenStore {
  load(): Promise<StoredTokens | undefined>;
  save(tokens: StoredTokens): Promise<void>;
  /** Run `fn` while holding an exclusive lock on the store. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export function defaultTokenStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.MELI_TOKEN_STORE ||
    path.join(os.homedir(), ".config", "meli-comprador-mcp", "tokens.json")
  );
}

export class FileTokenStore implements TokenStore {
  constructor(readonly filePath: string = defaultTokenStorePath()) {}

  async load(): Promise<StoredTokens | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<StoredTokens>;
    if (!parsed.access_token || !parsed.refresh_token || typeof parsed.expires_at !== "number") {
      throw new Error(`Token store ${this.filePath} is malformed; run \`pnpm auth\` again.`);
    }
    return parsed as StoredTokens;
  }

  async save(tokens: StoredTokens): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    // Write-then-rename so a crash never leaves a half-written store (which
    // would lose the single-use refresh token).
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx");
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await fs.stat(lockPath).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() > deadline) {
          throw new Error(`Timed out waiting for token store lock ${lockPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(lockPath, { force: true });
    }
  }
}

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  user_id?: number;
  scope?: string;
}

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | undefined,
    message: string
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/** POST /oauth/token (form-encoded). Never includes secrets in thrown messages. */
export async function requestToken(
  body: Record<string, string>,
  now: () => number = Date.now
): Promise<Omit<StoredTokens, "refresh_token"> & { refresh_token?: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON error body
  }
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : undefined;
    const detail = typeof json.message === "string" ? json.message : code ?? `HTTP ${res.status}`;
    throw new OAuthError(res.status, code, `MercadoLibre OAuth ${body.grant_type} failed: ${detail}`);
  }
  const data = json as unknown as OAuthTokenResponse;
  if (!data.access_token || typeof data.expires_in !== "number") {
    throw new OAuthError(res.status, undefined, "MercadoLibre OAuth response missing access_token/expires_in");
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: now() + data.expires_in * 1000,
    user_id: data.user_id,
    scope: data.scope,
  };
}

export interface TokenManagerOptions {
  store: TokenStore;
  /** Needed to refresh. Without it, stored tokens are used until they expire. */
  oauth?: OAuthClientConfig;
  /** Used when the store is empty (e.g. MERCADOLIBRE_ACCESS_TOKEN). */
  fallbackToken?: string;
  now?: () => number;
  /** Diagnostics sink (stderr in the CLI). Never receives token values. */
  log?: (message: string) => void;
}

export class TokenManager implements AccessTokenProvider {
  private readonly store: TokenStore;
  private readonly oauth?: OAuthClientConfig;
  private readonly fallbackToken?: string;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private inflight?: Promise<string | undefined>;

  constructor(options: TokenManagerOptions) {
    this.store = options.store;
    this.oauth = options.oauth;
    this.fallbackToken = options.fallbackToken;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  private isFresh(tokens: StoredTokens): boolean {
    return tokens.expires_at - this.now() > REFRESH_MARGIN_MS;
  }

  async getAccessToken(): Promise<string | undefined> {
    const tokens = await this.store.load();
    if (!tokens) return this.fallbackToken;
    if (this.isFresh(tokens)) return tokens.access_token;
    try {
      return await this.refresh(tokens.access_token);
    } catch (error) {
      // Inside the safety margin the old token still works; don't fail the call.
      if (tokens.expires_at > this.now()) {
        this.log(
          JSON.stringify({
            level: "warn",
            msg: "meli_token_refresh_failed_using_current",
            error: error instanceof Error ? error.message : String(error),
          })
        );
        return tokens.access_token;
      }
      throw error;
    }
  }

  async forceRefresh(staleToken: string | undefined): Promise<string | undefined> {
    const tokens = await this.store.load();
    if (!tokens) return undefined;
    return this.refresh(staleToken);
  }

  /**
   * Renew unless someone else already did. `staleToken` is the access token
   * the caller considers unusable; if the store already holds a different,
   * fresh one (another call or process refreshed first) that one is returned
   * without spending the refresh token again.
   */
  private refresh(staleToken: string | undefined): Promise<string | undefined> {
    if (!this.inflight) {
      this.inflight = this.store
        .withLock(() => this.refreshLocked(staleToken))
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }

  private async refreshLocked(staleToken: string | undefined): Promise<string | undefined> {
    const current = await this.store.load();
    if (!current) return this.fallbackToken;
    if (current.access_token !== staleToken && this.isFresh(current)) {
      return current.access_token;
    }
    if (!this.oauth) {
      throw new Error(
        "MercadoLibre access token expired and MELI_CLIENT_ID / MELI_CLIENT_SECRET are not set, so it cannot be renewed."
      );
    }

    let renewed;
    try {
      renewed = await requestToken(
        {
          grant_type: "refresh_token",
          client_id: this.oauth.clientId,
          client_secret: this.oauth.clientSecret,
          refresh_token: current.refresh_token,
        },
        this.now
      );
    } catch (error) {
      if (error instanceof OAuthError && error.errorCode === "invalid_grant") {
        throw new Error(
          "MercadoLibre refresh token was rejected (invalid_grant: revoked, expired or already used). Run `pnpm auth` to authorize again."
        );
      }
      throw error;
    }

    await this.store.save({
      ...current,
      ...renewed,
      // Single-use refresh token rotates; keep the old one only if ML did not send a new one.
      refresh_token: renewed.refresh_token ?? current.refresh_token,
      user_id: renewed.user_id ?? current.user_id,
      scope: renewed.scope ?? current.scope,
    });
    this.log(
      JSON.stringify({
        level: "info",
        msg: "meli_token_refreshed",
        expires_at: new Date(renewed.expires_at).toISOString(),
        refresh_token_rotated: Boolean(renewed.refresh_token),
      })
    );
    return renewed.access_token;
  }
}

/** Build a TokenManager from env vars (MELI_CLIENT_ID, MELI_CLIENT_SECRET, MELI_REDIRECT_URI, MELI_TOKEN_STORE, MERCADOLIBRE_ACCESS_TOKEN). */
export function tokenManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log?: (message: string) => void
): TokenManager {
  const oauth =
    env.MELI_CLIENT_ID && env.MELI_CLIENT_SECRET
      ? {
          clientId: env.MELI_CLIENT_ID,
          clientSecret: env.MELI_CLIENT_SECRET,
          redirectUri: env.MELI_REDIRECT_URI,
        }
      : undefined;
  return new TokenManager({
    store: new FileTokenStore(defaultTokenStorePath(env)),
    oauth,
    fallbackToken: env.MERCADOLIBRE_ACCESS_TOKEN || undefined,
    log,
  });
}
