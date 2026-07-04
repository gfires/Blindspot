import { describe, it, expect } from "vitest";
import { blocklistKey, isHardBlock } from "@/lib/blocklist";

describe("blocklistKey", () => {
  it("strips www and lowercases a bare hostname", () => {
    expect(blocklistKey("WWW.Reddit.com")).toBe("reddit.com");
  });

  it("extracts the host from a full URL", () => {
    expect(blocklistKey("https://www.linkedin.com/jobs/xyz")).toBe("linkedin.com");
  });

  it("treats www and non-www as the same key", () => {
    expect(blocklistKey("reddit.com")).toBe(blocklistKey("https://www.reddit.com/r/x"));
  });
});

describe("isHardBlock", () => {
  it("classifies 401/403/429/451 as hard blocks", () => {
    for (const s of [401, 403, 429, 451]) expect(isHardBlock(s)).toBe(true);
  });

  it("does NOT classify transient/dead-link statuses as blocks", () => {
    for (const s of [0, 404, 500, 502, 503, undefined]) expect(isHardBlock(s)).toBe(false);
  });

  it("falls back to sniffing the status code out of the error message", () => {
    expect(isHardBlock(undefined, "Failed to scrape URL. Status code: 403. Error: ...")).toBe(true);
    expect(isHardBlock(undefined, "No response received while trying to scrape URL.")).toBe(false);
  });
});
