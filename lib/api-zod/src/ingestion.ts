// @workspace/api-zod — shared ingestion contract.
// COMMIT A: Platform-owned cross-lane contract. INGEST-WORKER produces it; manuscript
// routes consume `import { CanonicalSubmissionPayload } from "@workspace/api-zod"`.
// Authored as Zod schemas (this package's idiom) so downstream lanes get runtime
// validation for free; static types are inferred from the schemas.
import { z } from "zod";

export const SourceType = z.enum(["text", "pdf", "docx", "latex"]);
export type SourceType = z.infer<typeof SourceType>;

export const ArticleType = z.enum([
  "research_article",
  "narrative_review",
  "case_report",
  "editorial",
  "tool_announcement",
  "hypothesis",
  "protocol",
  "meeting_report",
  "white_paper",
  "thesis",
  "unknown",
]);
export type ArticleType = z.infer<typeof ArticleType>;

export const NormalizedHeading = z.enum([
  "abstract",
  "introduction",
  "methods",
  "results",
  "discussion",
  "references",
  "other",
]);
export type NormalizedHeading = z.infer<typeof NormalizedHeading>;

export const ManuscriptSection = z.object({
  heading: z.string(),
  normalizedHeading: NormalizedHeading,
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().nonnegative(),
  text: z.string(),
});
export type ManuscriptSection = z.infer<typeof ManuscriptSection>;

export const IntegritySignals = z.object({
  plagiarismRisk: z.boolean(),
  patientIdentifiable: z.boolean(),
  dualUseRisk: z.boolean(),
});
export type IntegritySignals = z.infer<typeof IntegritySignals>;

export const ManuscriptFactSheet = z.object({
  sectionsPresent: z.array(z.string()),
  declaredSubjectCategory: z.string().nullable(),
  declaredArticleType: ArticleType,
  hasNewData: z.boolean(),
  hasMethodsDetail: z.boolean(),
  methodsDetailSignals: z.array(z.string()),
  hasResults: z.boolean(),
  computationalOnly: z.boolean(),
  integritySignals: IntegritySignals,
});
export type ManuscriptFactSheet = z.infer<typeof ManuscriptFactSheet>;

export const ExtractionTraceStep = z.object({
  stage: z.enum(["decode", "segment", "factsheet", "validate"]),
  ok: z.boolean(),
  detail: z.string().optional(),
  ms: z.number().nonnegative(),
});
export type ExtractionTraceStep = z.infer<typeof ExtractionTraceStep>;

export const CanonicalSubmissionPayload = z.object({
  schemaVersion: z.literal("1.0"),
  submissionId: z.string().uuid(),
  tenantId: z.string(),
  workspaceId: z.number().int(),
  title: z.string().nullable(),
  sourceType: SourceType,
  rawText: z.string(),
  pdfStorageKey: z.string().nullable(),
  sections: z.array(ManuscriptSection),
  factSheet: ManuscriptFactSheet,
  charCount: z.number().int().nonnegative(),
  extractionTrace: z.array(ExtractionTraceStep),
});
export type CanonicalSubmissionPayload = z.infer<typeof CanonicalSubmissionPayload>;

export const IngestError = z.object({
  code: z.enum([
    "UNREADABLE_SOURCE",
    "UNSUPPORTED_TYPE",
    "EMPTY_DOCUMENT",
    "SCHEMA_VALIDATION_FAILED",
  ]),
  message: z.string(),
  extractionTrace: z.array(ExtractionTraceStep),
});
export type IngestError = z.infer<typeof IngestError>;

// Discriminated union — never a partial payload.
export const IngestResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), payload: CanonicalSubmissionPayload }),
  z.object({ ok: z.literal(false), error: IngestError }),
]);
export type IngestResult = z.infer<typeof IngestResult>;
