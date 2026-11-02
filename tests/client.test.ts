import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MercadoLibreClient,
  getRequestAccessToken,
  runWithRequestAccessToken,
} from "../src/client.js";
import { MercadoLibreError } from "../src/errors.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MercadoLibreClient", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("sends GET request without auth when no token", async () => {
    const client = new MercadoLibreClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "MLA123" }));

    await client.get("/items/MLA123");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.mercadolibre.com/items/MLA123",
      expect.objectContaining({
        method: "GET",
        headers: expect.not.objectContaining({ Authorization: expect.any(String) }),
      })
    );
  });

  it("sends GET request with Bearer token when token provided", async () => {
    const client = new MercadoLibreClient("TEST_TOKEN");
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "MLA123" }));

    await client.get("/items/MLA123");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.mercadolibre.com/items/MLA123",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer TEST_TOKEN" }),
      })
    );
  });

  it("appends query params to URL", async () => {
    const client = new MercadoLibreClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));

    await client.get("/sites/MLA/search", { q: "iphone", limit: "10" });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.mercadolibre.com/sites/MLA/search?q=iphone&limit=10",
      expect.any(Object)
    );
  });

  it("throws MercadoLibreError on non-OK response", async () => {
    const client = new MercadoLibreClient();
    mockFetch.mockResolvedValueOnce(new Response("Not Found", { status: 404 }));

    await expect(client.get("/items/INVALID")).rejects.toThrow(MercadoLibreError);
  });

  it("error has correct properties", async () => {
    const client = new MercadoLibreClient();
    mockFetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    try {
      await client.get("/users/me");
      expect.fail("Should have thrown");
    } catch (e) {
      const err = e as MercadoLibreError;
      expect(err.status).toBe(401);
      expect(err.isUnauthorized).toBe(true);
      expect(err.isNotFound).toBe(false);
      expect(err.method).toBe("GET");
      expect(err.path).toBe("/users/me");
    }
  });

  it("returns parsed JSON response", async () => {
    const client = new MercadoLibreClient();
    const data = { id: "MLA999", title: "Test Item" };
    mockFetch.mockResolvedValueOnce(jsonResponse(data));

    const result = await client.get("/items/MLA999");
    expect(result).toEqual(data);
  });

  it("keeps per-request access tokens isolated under concurrency", async () => {
    const client = new MercadoLibreClient("STATIC_TOKEN");
    const seenAuthHeaders: string[] = [];

    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      seenAuthHeaders.push(headers.Authorization);
      await new Promise((resolve) => setTimeout(resolve, 1));
      return jsonResponse({ ok: true });
    });

    await Promise.all([
      runWithRequestAccessToken("TOKEN_A", async () => {
        await client.get("/users/me");
      }),
      runWithRequestAccessToken("TOKEN_B", async () => {
        await client.get("/users/me");
      }),
    ]);

    expect(seenAuthHeaders).toHaveLength(2);
    expect(seenAuthHeaders).toContain("Bearer TOKEN_A");
    expect(seenAuthHeaders).toContain("Bearer TOKEN_B");
  });
});

describe("request token context inheritance (regression: tool-token clobber)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("getRequestAccessToken returns the active request token", async () => {
    await runWithRequestAccessToken("APP_USR-OUTER", async () => {
      expect(getRequestAccessToken()).toBe("APP_USR-OUTER");
    });
    expect(getRequestAccessToken()).toBeUndefined();
  });

  // The bug: a tool registered as `toolResult(() => tools.x(params))` (no
  // `extra`) re-ran the handler inside `runWithRequestAccessToken(undefined)`,
  // which starts a fresh context and drops the token the outer `server.tool`
  // wrapper already set — so ML returned 401 "authorization value not
  // present" for every tool except the few that forwarded `extra`.
  it("re-wrapping with undefined drops the Authorization header", async () => {
    const client = new MercadoLibreClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "MLA1" }));

    await runWithRequestAccessToken("APP_USR-OUTER", async () => {
      await runWithRequestAccessToken(undefined, async () => {
        await client.get("/products/MLA1");
      });
    });

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  // The fix: tool wrappers now resolve the token as
  // `fromExtra ?? getRequestAccessToken()`, so when `extra` is absent the
  // outer request token is inherited instead of clobbered.
  it("falling back to getRequestAccessToken preserves auth when extra is absent", async () => {
    const client = new MercadoLibreClient();
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: "MLA1" }));

    await runWithRequestAccessToken("APP_USR-OUTER", async () => {
      const token = (undefined as string | undefined) ?? getRequestAccessToken();
      await runWithRequestAccessToken(token, async () => {
        await client.get("/products/MLA1");
      });
    });

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer APP_USR-OUTER");
  });
});
