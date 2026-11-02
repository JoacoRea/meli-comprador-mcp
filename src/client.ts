import { AsyncLocalStorage } from "async_hooks";
import { createHash } from "node:crypto";
import { MercadoLibreError } from "./errors.js";

const BASE_URL = "https://api.mercadolibre.com";

/**
 * Redacted view of the inbound `Authorization: Bearer` header for the
 * current request. Used by error logs so operators can tell whether a
 * failed MercadoLibre call carried an end-user OAuth token forwarded by
 * the gateway (`source: "request"`) or fell back to the service-account
 * env-var token (`source: "none"`).
 *
 * Never carries the raw token — only a sha256[:10] fingerprint and the
 * APP_USR / other / none prefix bucket.
 */
export type InboundAuthContext = {
  source: "request" | "none";
  prefix: "APP_USR" | "other" | "none";
  fp: string;
};

export type RedactedInboundHeaders = Record<string, string | string[]>;

type RequestAuthContext = {
  accessToken?: string;
  inbound: InboundAuthContext;
  inboundHeaders?: RedactedInboundHeaders;
};

const requestAccessTokenStorage = new AsyncLocalStorage<RequestAuthContext>();

function tokenFingerprint(token: string | undefined): string {
  if (!token) return "none";
  return createHash("sha256").update(token).digest("hex").slice(0, 10);
}

function tokenPrefix(token: string | undefined): "APP_USR" | "other" | "none" {
  if (!token) return "none";
  return token.startsWith("APP_USR") ? "APP_USR" : "other";
}

/** Convert a fetch Headers object to a plain {name: value} record for log emission. */
export function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

export async function runWithRequestAccessToken<T>(
  accessToken: string | undefined,
  callback: () => Promise<T>,
  inboundHeaders?: RedactedInboundHeaders
): Promise<T> {
  return requestAccessTokenStorage.run(
    {
      accessToken,
      inbound: {
        source: accessToken ? "request" : "none",
        prefix: tokenPrefix(accessToken),
        fp: tokenFingerprint(accessToken),
      },
      inboundHeaders,
    },
    callback
  );
}

export function getInboundAuthContext(): InboundAuthContext {
  return (
    requestAccessTokenStorage.getStore()?.inbound ?? {
      source: "none",
      prefix: "none",
      fp: "none",
    }
  );
}

export function getRequestInboundHeaders(): RedactedInboundHeaders | undefined {
  return requestAccessTokenStorage.getStore()?.inboundHeaders;
}

/**
 * The access token bound to the current request's AsyncLocalStorage
 * context, if any. The tool wrappers use this as a fallback so an inner
 * re-wrap that lacks an explicit `extra` inherits the token the outer
 * `server.tool` wrapper already established instead of clobbering it with
 * `undefined` (which would strip the Authorization header → ML 401
 * "authorization value not present").
 */
export function getRequestAccessToken(): string | undefined {
  return requestAccessTokenStorage.getStore()?.accessToken;
}

/**
 * Source of OAuth access tokens that can renew itself (see
 * `TokenManager` in token-manager.ts).
 */
export interface AccessTokenProvider {
  /** A token that is valid for at least the next few minutes, if any. */
  getAccessToken(): Promise<string | undefined>;
  /**
   * Called after ML answered 401 to a request sent with `staleToken`.
   * Returns a renewed token, or undefined when renewal is not possible.
   */
  forceRefresh(staleToken: string | undefined): Promise<string | undefined>;
}

/**
 * Read-only MercadoLibre REST client (GET only).
 *
 * Token resolution per request:
 *   1. the inbound `Authorization: Bearer` of the current MCP request (HTTP mode)
 *   2. the `AccessTokenProvider` (auto-refreshing token store) or static token
 *
 * When the token came from a provider and ML answers 401, the provider is
 * asked to renew and the request is retried exactly once.
 */
export class MercadoLibreClient {
  private readonly staticToken?: string;
  private readonly provider?: AccessTokenProvider;

  constructor(auth?: string | AccessTokenProvider) {
    if (typeof auth === "string") {
      this.staticToken = auth;
    } else if (auth) {
      this.provider = auth;
    }
  }

  private headers(token: string | undefined): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      h.Authorization = `Bearer ${token}`;
    }
    return h;
  }

  async get<T = unknown>(path: string, params?: Record<string, string>): Promise<T> {
    let url = `${BASE_URL}${path}`;
    if (params) {
      const qs = new URLSearchParams(params).toString();
      if (qs) url += `?${qs}`;
    }

    const requestAccessToken = requestAccessTokenStorage.getStore()?.accessToken;
    if (requestAccessToken) {
      return this.send<T>(url, path, requestAccessToken);
    }
    if (!this.provider) {
      return this.send<T>(url, path, this.staticToken);
    }

    const token = await this.provider.getAccessToken();
    try {
      return await this.send<T>(url, path, token);
    } catch (error) {
      if (!(error instanceof MercadoLibreError) || !error.isUnauthorized) throw error;
      const renewed = await this.provider.forceRefresh(token);
      if (!renewed || renewed === token) throw error;
      return this.send<T>(url, path, renewed);
    }
  }

  private async send<T>(url: string, path: string, token: string | undefined): Promise<T> {
    const res = await fetch(url, {
      method: "GET",
      headers: this.headers(token),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const responseBody = await res.text();
      throw new MercadoLibreError(
        "GET",
        path,
        res.status,
        responseBody,
        headersToObject(res.headers)
      );
    }
    return res.json() as Promise<T>;
  }
}
