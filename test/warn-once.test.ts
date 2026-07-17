import { describe, it, expect, beforeEach, vi } from "vitest";
import { warnOnce, resetWarnOnce } from "@/lib/warn-once";

describe("warnOnce", () => {
  beforeEach(() => {
    resetWarnOnce();
  });

  it("warns exactly once per key", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnOnce("supabase", "down");
    warnOnce("supabase", "down");
    warnOnce("supabase", "down");

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("down");

    spy.mockRestore();
  });

  it("warns again for a different key", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnOnce("supabase", "a");
    warnOnce("firecrawl", "b");

    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });

  it("warns again after reset", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnOnce("supabase", "down");
    resetWarnOnce();
    warnOnce("supabase", "down");

    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });
});
