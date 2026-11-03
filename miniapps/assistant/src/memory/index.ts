export * from "./types"
export * from "./memory"
export {FakeEmbeddingProvider, HttpEmbeddingProvider, EmbeddingUnavailableError} from "./embeddings"
export {MemoryKeyValueStore, MemoryBlobStore} from "./ports"
export type {KeyValueStore, BlobStore} from "./ports"
export {SensitiveInferenceError} from "./sensitive"
export {UnscopedCaptureError, RevokedScopeError, MAX_PAGE_SIZE} from "./memory"
export {MemoryMaintenance, type MaintenanceOptions, type MaintenanceReport} from "./maintenance"
export {
  CONTRADICTION_THRESHOLD,
  DUPLICATE_THRESHOLD,
  PROMOTION_THRESHOLD,
  mergeable,
  mergeInto,
  planConsolidation,
  tokenOverlap,
  type ConsolidationPlan,
  type Contradiction,
  type DuplicateGroup,
  type Promotion,
} from "./consolidate"
