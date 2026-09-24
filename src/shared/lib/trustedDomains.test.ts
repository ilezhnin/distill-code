import { describe, it, expect, beforeEach } from "vitest";
import {
  isDomainTrusted,
  isUrlTrusted,
  trustDomain,
  untrustDomain,
} from "./trustedDomains";

describe("trustedDomains", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe("isDomainTrusted", () => {
    it("is case-insensitive", () => {
      trustDomain("GitHub.COM");
      expect(isDomainTrusted("github.com")).toBe(true);
    });
  });

  describe("isUrlTrusted", () => {
    it("returns true for URLs with www prefix on trusted domains", () => {
      trustDomain("github.com");
      expect(isUrlTrusted("https://www.github.com/squareup/repo")).toBe(true);
    });

    it("returns false for URLs with untrusted domains", () => {
      expect(isUrlTrusted("https://phishing-site.com/login")).toBe(false);
    });
  });

  describe("trustDomain / untrustDomain", () => {
    it("adds and removes user-trusted domains", () => {
      trustDomain("custom.example.com");
      expect(isDomainTrusted("custom.example.com")).toBe(true);

      untrustDomain("custom.example.com");
      expect(isDomainTrusted("custom.example.com")).toBe(false);
    });
  });
});
