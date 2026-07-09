import { z } from "zod";

export const EvidenceSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  domain: z.string(),
  title: z.string(),
  snippet: z.string(),
  content: z.string(),
  contentHash: z.string(),
  sourceQuery: z.string(),
  loopIteration: z.number().int(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;
