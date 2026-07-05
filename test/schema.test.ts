import { describe, it, expect } from "vitest";
import { LlmReportSchema, ScanReportSchema } from "@/lib/schema";

/** A minimal valid LLM report used as a fixture base. */
const validLlm = {
  industry: "test industry",
  scores: {
    pain: { value: 7, label: "High", reason: "many complaints across forums" },
    softwareMaturity: { value: 3, label: "Legacy", reason: "mostly pre-2010 tools" },
    laborScarcity: { value: 6, label: "Tight", reason: "open roles outnumber candidates" },
    aiSuitability: { value: 8, label: "Ripe", reason: "repetitive manual workflows" },
    budgetSignal: { value: 5, label: "Some", reason: "mid-market deal sizes" },
  },
  snapshot: "A snapshot.",
  softwareEcosystem: { summary: "legacy vendors", vendors: [{ name: "Acme", note: "old", sourceIds: [1] }] },
  bottlenecks: [{ text: "manual review", sourceIds: [2] }],
  underservedNiches: [{ text: "rural ops", sourceIds: [] }],
  opportunityThesis: "There is a clear opportunity to build X because Y.",
  adjacentMarkets: [{ text: "logistics", sourceIds: [] }],
  nextSteps: [{ text: "Interview 10 coordinators to validate pain", sourceIds: [] }],
  playfulStats: [{ label: "Excel Dependency", value: "Severe" }],
};

describe("LlmReportSchema", () => {
  it("accepts a well-formed report", () => {
    expect(LlmReportSchema.safeParse(validLlm).success).toBe(true);
  });

  it("rejects an out-of-range score", () => {
    const bad = { ...validLlm, scores: { ...validLlm.scores, pain: { value: 42, label: "x", evidence: [] } } };
    expect(LlmReportSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a missing required section", () => {
    const { snapshot, ...bad } = validLlm;
    expect(LlmReportSchema.safeParse(bad).success).toBe(false);
  });

  it("defaults empty reason string", () => {
    const input = { ...validLlm, scores: { ...validLlm.scores, softwareMaturity: { value: 3, label: "Legacy" } } };
    const parsed = LlmReportSchema.parse(input);
    expect(parsed.scores.softwareMaturity.reason).toBe("");
  });
});

describe("ScanReportSchema", () => {
  it("requires the server-owned fields the LLM schema omits", () => {
    // The LLM fixture lacks sources/generatedAt/opportunityScore, so it must fail the full schema.
    expect(ScanReportSchema.safeParse(validLlm).success).toBe(false);
  });

  it("accepts a fully-assembled report", () => {
    const full = {
      ...validLlm,
      generatedAt: "2026-01-01T00:00:00.000Z",
      opportunityScore: 72,
      sources: [{ id: 1, url: "https://a.com", domain: "a.com", title: "A", intent: "software" }],
    };
    expect(ScanReportSchema.safeParse(full).success).toBe(true);
  });
});
