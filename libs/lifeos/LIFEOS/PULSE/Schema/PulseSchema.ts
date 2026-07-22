import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

export const KindSchema = z.enum(["collection", "narrative", "reference", "index"]);
export type Kind = z.infer<typeof KindSchema>;

export const CategorySchema = z.union([
  z.enum(["identity", "voice", "mind", "taste", "shape", "ops", "domain"]),
  z.string().min(1),
]);
export type Category = z.infer<typeof CategorySchema>;

export const PublishSchema = z.enum(["false", "daemon-summary", "daemon", "public"]);
export type Publish = z.infer<typeof PublishSchema>;

export const ReviewCadenceSchema = z.enum(["30d", "90d", "180d", "365d", "never"]);
export type ReviewCadence = z.infer<typeof ReviewCadenceSchema>;

export const ProvenanceSchema = z.enum(["template", "customized", "mixed"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const PageMetaSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  pageId: z.string().min(1),
  lastBuildAt: z.string().datetime(),
  sourceHashes: z.record(z.string(), z.string()),
  adapterVersion: z.string().min(1),
  model: z.string().min(1),
  costUSD: z.number().min(0),
  latencyMs: z.number().int().min(0),
  provenance: ProvenanceSchema,
  warnings: z.array(z.string()).default([]),
});
export type PageMeta = z.infer<typeof PageMetaSchema>;

export const CollectionItemSchema = z.object({
  name: z.string().min(1),
  creator: z.string().optional(),
  rating: z.number().int().min(1).max(10).optional(),
  notes: z.string().optional(),
  private: z.boolean().default(false),
});
export type CollectionItem = z.infer<typeof CollectionItemSchema>;

export const CollectionPageSchema = z.object({
  kind: z.literal("collection"),
  title: z.string().min(1),
  category: CategorySchema,
  description: z.string().optional(),
  items: z.array(CollectionItemSchema),
  meta: PageMetaSchema,
});
export type CollectionPage = z.infer<typeof CollectionPageSchema>;

export const NarrativeSectionSchema = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
  level: z.number().int().min(1).max(6).default(2),
});
export type NarrativeSection = z.infer<typeof NarrativeSectionSchema>;

export const NarrativePageSchema = z.object({
  kind: z.literal("narrative"),
  title: z.string().min(1),
  category: CategorySchema,
  lede: z.string().optional(),
  sections: z.array(NarrativeSectionSchema),
  pullQuotes: z.array(z.string()).default([]),
  meta: PageMetaSchema,
});
export type NarrativePage = z.infer<typeof NarrativePageSchema>;

export const ReferenceEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  notes: z.string().optional(),
  group: z.string().optional(),
});
export type ReferenceEntry = z.infer<typeof ReferenceEntrySchema>;

export const ReferencePageSchema = z.object({
  kind: z.literal("reference"),
  title: z.string().min(1),
  category: CategorySchema,
  description: z.string().optional(),
  entries: z.array(ReferenceEntrySchema),
  meta: PageMetaSchema,
});
export type ReferencePage = z.infer<typeof ReferencePageSchema>;

export const IndexChildSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  kind: KindSchema,
  preview: z.string().optional(),
  category: CategorySchema.optional(),
});
export type IndexChild = z.infer<typeof IndexChildSchema>;

export const IndexPageSchema = z.object({
  kind: z.literal("index"),
  title: z.string().min(1),
  category: CategorySchema,
  description: z.string().optional(),
  children: z.array(IndexChildSchema),
  meta: PageMetaSchema,
});
export type IndexPage = z.infer<typeof IndexPageSchema>;

export const PageDataSchema = z.discriminatedUnion("kind", [
  CollectionPageSchema,
  NarrativePageSchema,
  ReferencePageSchema,
  IndexPageSchema,
]);
export type PageData = z.infer<typeof PageDataSchema>;

export const KIND_TO_SCHEMA: Record<Kind, z.ZodTypeAny> = {
  collection: CollectionPageSchema,
  narrative: NarrativePageSchema,
  reference: ReferencePageSchema,
  index: IndexPageSchema,
};

export const ALL_PAGE_SCHEMAS = {
  CollectionPageSchema,
  NarrativePageSchema,
  ReferencePageSchema,
  IndexPageSchema,
  PageDataSchema,
  PageMetaSchema,
} as const;

export type PageSchemaName = keyof typeof ALL_PAGE_SCHEMAS;

export function getSchemaByName(name: string): z.ZodTypeAny | null {
  if (name in ALL_PAGE_SCHEMAS) {
    return ALL_PAGE_SCHEMAS[name as PageSchemaName];
  }
  return null;
}

export function validatePageData(input: unknown): { ok: true; data: PageData } | { ok: false; errors: z.ZodIssue[] } {
  const result = PageDataSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: result.error.issues };
}

export function emptyMeta(pageId: string, model: string, adapterVersion: string): PageMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    pageId,
    lastBuildAt: new Date().toISOString(),
    sourceHashes: {},
    adapterVersion,
    model,
    costUSD: 0,
    latencyMs: 0,
    provenance: "template",
    warnings: [],
  };
}
