import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MercadoLibreClient, runWithRequestAccessToken } from "../src/client.js";
import {
  FileTokenStore,
  TOKEN_URL,
  TokenManager,
  type StoredTokens,
} from "../src/token-manager.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const oauth = { clientId: "CID", clientSecret: "SECRET" };

let dir: string;
let store: FileTokenStore;

async function seed(tokens: Partial<StoredTokens> = {}) {
  await store.save({
    access_token: "APP_USR-OLD",
    refresh_token: "TG-R1",
    expires_at: NOW + 6 * HOUR,
    ...tokens,
  });
}

function manager(extra: Partial<ConstructorParameters<typeof TokenManager>[0]> = {}) {
  return new TokenManager({ store, oauth, now: () => NOW, ...extra });
}

function oauthCalls() {
  return mockFetch.mock.calls.filter(([url]) => url === TOKEN_URL);
}

function refreshResponse(n: number) {
  return jsonResponse({
    access_token: `APP_USR-NEW${n}`,
    refresh_token: `TG-R${n + 1}`,
    expires_in: 21600,
    user_id: 42,
  });
}

beforeEach(async () => {
  mockFetch.mockReset();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "meli-tokens-"));
  store = new FileTokenStore(path.join(dir, "tokens.json"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("TokenManager", () => {
  it("returns the stored token without refreshing while it is valid", async () => {
    await seed();
    await expect(manager().getAccessToken()).resolves.toBe("APP_USR-OLD");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refreshes when the token expires in less than 5 minutes and saves the rotated refresh token", async () => {
    await seed({ expires_at: NOW + 4 * 60 * 1000 });
    mockFetch.mockResolvedValueOnce(refreshResponse(1));

    await expect(manager().getAccessToken()).resolves.toBe("APP_USR-NEW1");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("TG-R1");
    expect(body.get("client_id")).toBe("CID");
    expect(body.get("client_secret")).toBe("SECRET");

    const saved = await store.load();
    expect(saved).toMatchObject({
      access_token: "APP_USR-NEW1",
      refresh_token: "TG-R2",
      expires_at: NOW + 21600 * 1000,
    });
  });

  it("refreshes an already-expired token", async () => {
    await seed({ expires_at: NOW - HOUR });
    mockFetch.mockResolvedValueOnce(refreshResponse(1));
    await expect(manager().getAccessToken()).resolves.toBe("APP_USR-NEW1");
  });

  it("keeps the previous refresh token if ML does not send a new one", async () => {
    await seed({ expires_at: NOW - HOUR });
    mockFetch.mockResolvedValueOnce(jsonResponse({ access_token: "APP_USR-NEW", expires_in: 21600 }));
    await manager().getAccessToken();
    expect((await store.load())?.refresh_token).toBe("TG-R1");
  });

  it("serializes concurrent refreshes so the single-use refresh token is spent once", async () => {
    await seed({ expires_at: NOW - HOUR });
    mockFetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return refreshResponse(1);
    });

    const m = manager();
    const tokens = await Promise.all([m.getAccessToken(), m.getAccessToken(), m.getAccessToken()]);

    expect(tokens).toEqual(["APP_USR-NEW1", "APP_USR-NEW1", "APP_USR-NEW1"]);
    expect(oauthCalls()).toHaveLength(1);
  });

  it("serializes refreshes across managers sharing one store (separate processes)", async () => {
    await seed({ expires_at: NOW - HOUR });
    let n = 0;
    mockFetch.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return refreshResponse(++n);
    });

    const a = manager();
    const b = new TokenManager({ store: new FileTokenStore(store.filePath), oauth, now: () => NOW });
    const [ta, tb] = await Promise.all([a.getAccessToken(), b.getAccessToken()]);

    expect(oauthCalls()).toHaveLength(1);
    expect(ta).toBe("APP_USR-NEW1");
    expect(tb).toBe("APP_USR-NEW1");
  });

  it("explains how to recover when the refresh token is rejected", async () => {
    await seed({ expires_at: NOW - HOUR });
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "invalid_grant", message: "invalid_grant" }, 400));
    await expect(manager().getAccessToken()).rejects.toThrow(/pnpm auth/);
  });

  it("uses the current token if refresh fails inside the safety margin", async () => {
    await seed({ expires_at: NOW + 60 * 1000 });
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: "server_error" }, 500));
    await expect(manager().getAccessToken()).resolves.toBe("APP_USR-OLD");
  });

  it("falls back to MERCADOLIBRE_ACCESS_TOKEN when the store is empty", async () => {
    await expect(manager({ fallbackToken: "APP_USR-ENV" }).getAccessToken()).resolves.toBe("APP_USR-ENV");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("never logs token values", async () => {
    await seed({ expires_at: NOW - HOUR });
    mockFetch.mockResolvedValueOnce(refreshResponse(1));
    const lines: string[] = [];
    await manager({ log: (l) => lines.push(l) }).getAccessToken();
    const all = lines.join("\n");
    expect(all).toContain("meli_token_refreshed");
    expect(all).not.toMatch(/APP_USR|TG-R|SECRET/);
  });
});

describe("MercadoLibreClient with TokenManager", () => {
  it("on 401 refreshes and retries exactly once", async () => {
    await seed();
    mockFetch
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(refreshResponse(1))
      .mockResolvedValueOnce(jsonResponse({ id: "MLA1" }));

    const client = new MercadoLibreClient(manager());
    await expect(client.get("/products/MLA1")).resolves.toEqual({ id: "MLA1" });

    const auths = mockFetch.mock.calls
      .filter(([url]) => url !== TOKEN_URL)
      .map(([, init]) => (init as RequestInit & { headers: Record<string, string> }).headers.Authorization);
    expect(auths).toEqual(["Bearer APP_USR-OLD", "Bearer APP_USR-NEW1"]);
    expect((await store.load())?.refresh_token).toBe("TG-R2");
  });

  it("does not loop when the retried request is also 401", async () => {
    await seed();
    mockFetch
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(refreshResponse(1))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));

    const client = new MercadoLibreClient(manager());
    await expect(client.get("/products/MLA1")).rejects.toMatchObject({ status: 401 });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does not refresh on non-401 errors", async () => {
    await seed();
    mockFetch.mockResolvedValueOnce(new Response("nope", { status: 403 }));
    const client = new MercadoLibreClient(manager());
    await expect(client.get("/products/MLA1")).rejects.toMatchObject({ status: 403 });
    expect(oauthCalls()).toHaveLength(0);
  });

  it("prefers the inbound Authorization header over the token store", async () => {
    await seed();
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new MercadoLibreClient(manager());

    await runWithRequestAccessToken("APP_USR-INBOUND", () => client.get("/users/me"));

    const init = mockFetch.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer APP_USR-INBOUND");
  });

  it("prefers the token store over MERCADOLIBRE_ACCESS_TOKEN", async () => {
    await seed();
    mockFetch.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new MercadoLibreClient(manager({ fallbackToken: "APP_USR-ENV" }));

    await client.get("/users/me");

    const init = mockFetch.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer APP_USR-OLD");
  });
});
