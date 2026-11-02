import { describe, it, expect } from "vitest";
import { parseAuthorizationResponse } from "../src/auth-cli.js";

describe("parseAuthorizationResponse", () => {
  it("extracts the code from the redirect URL and checks state", () => {
    expect(
      parseAuthorizationResponse("https://example.com/cb?code=TG-abc&state=S1", "S1")
    ).toBe("TG-abc");
  });

  it("rejects a mismatched state", () => {
    expect(() =>
      parseAuthorizationResponse("https://example.com/cb?code=TG-abc&state=EVIL", "S1")
    ).toThrow(/State mismatch/);
  });

  it("surfaces an authorization error", () => {
    expect(() =>
      parseAuthorizationResponse("https://example.com/cb?error=access_denied&state=S1", "S1")
    ).toThrow(/access_denied/);
  });

  it("accepts a bare code", () => {
    expect(parseAuthorizationResponse("  TG-abc \n", "S1")).toBe("TG-abc");
  });
});
