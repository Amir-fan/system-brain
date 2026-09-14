/**
 * @kip
 * @module model-gateway
 * @layer platform
 * @owner platform-infra
 * @feature K1-003
 * @purpose Embedding-capable model catalog (distinct from the chat model catalog).
 *
 * Why this exists: OpenRouter's GET /models lists chat/completion models only —
 * verified live, 445 entries, ZERO of them embedding models — while the
 * embeddings endpoint serves a separate family. Folding these into the chat
 * catalog would advertise models that cannot answer a chat request and would
 * make the assignment picker lie. Capabilities are therefore explicit here.
 *
 * K14 V1 locks one pair (provider + model + 1536 dimensions) because the pgvector
 * column is fixed-width: only models that can produce 1536 wide vectors are
 * assignable to the `embeddings` workload.
 */

export const LOCKED_EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingModelCapability {
  id: string;
  providerKey: 'openrouter';
  label: string;
  /** Native width before any Matryoshka truncation. */
  nativeDimensions: number;
  /** Widths this model can emit (MRL). The locked width must appear here. */
  supportedDimensions: number[];
  contextTokens: number;
  /** Listed provider price, USD per million input tokens. */
  pricePerMillionTokensUsd: number;
  multilingual: boolean;
  notes: string;
  /** True for the single approved V1 model. */
  approved: boolean;
}

export const EMBEDDING_MODEL_CATALOG: EmbeddingModelCapability[] = [
  {
    id: 'google/gemini-embedding-001',
    providerKey: 'openrouter',
    label: 'Gemini Embedding 001',
    nativeDimensions: 3072,
    supportedDimensions: [768, 1536, 3072],
    contextTokens: 20000,
    pricePerMillionTokensUsd: 0.15,
    multilingual: true,
    notes: 'Top of the MTEB Multilingual leaderboard; first-party Google hosting.',
    approved: true,
  },
  {
    id: 'qwen/qwen3-embedding-8b',
    providerKey: 'openrouter',
    label: 'Qwen3 Embedding 8B',
    nativeDimensions: 4096,
    supportedDimensions: [1536, 2048, 4096],
    contextTokens: 32768,
    pricePerMillionTokensUsd: 0.01,
    multilingual: true,
    notes: 'Strong multilingual and code retrieval; third-party hosting only.',
    approved: false,
  },
  {
    id: 'openai/text-embedding-3-large',
    providerKey: 'openrouter',
    label: 'Text Embedding 3 Large',
    nativeDimensions: 3072,
    supportedDimensions: [1536, 3072],
    contextTokens: 8192,
    pricePerMillionTokensUsd: 0.13,
    multilingual: true,
    notes: 'Reliable first-party serving; weaker Arabic than the leaders.',
    approved: false,
  },
  {
    id: 'baai/bge-m3',
    providerKey: 'openrouter',
    label: 'BGE-M3',
    nativeDimensions: 1024,
    supportedDimensions: [1024],
    contextTokens: 8192,
    pricePerMillionTokensUsd: 0.01,
    multilingual: true,
    notes: 'Purpose-built multilingual retrieval, but 1024-wide: not compatible with the locked column.',
    approved: false,
  },
];

/**
 * Models that actually work with the locked vector width. The admin UI offers
 * exactly these, so an assignment can never be saved that the schema would reject.
 */
export function assignableEmbeddingModels(
  lockedDimensions: number = LOCKED_EMBEDDING_DIMENSIONS,
): EmbeddingModelCapability[] {
  return EMBEDDING_MODEL_CATALOG.filter((m) => m.supportedDimensions.includes(lockedDimensions));
}

export function isAssignableEmbeddingModel(modelId: string, lockedDimensions = LOCKED_EMBEDDING_DIMENSIONS): boolean {
  return assignableEmbeddingModels(lockedDimensions).some((m) => m.id === modelId);
}
