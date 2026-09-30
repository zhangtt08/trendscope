/** Shared types for the semantic layer (Stage 6A §21/§45). */

export interface SimilarContentHit {
  contentItemId: number;
  title: string | null;
  platform: string;
  contentType: string;
  publishedAt: string | null;
  /** cosine similarity in [-1, 1]; UI renders as percent */
  similarity: number;
  /** §43: 所属话题(未归类为 null) */
  topicId: number | null;
  topicName: string | null;
  topicMemberCount: number | null;
}

export interface SimilarContentResult {
  embeddingSpace: {
    id: string;
    provider: string;
    model: string;
    mode: string;
    dimension: number;
  } | null;
  /** "api" = 真实模型语义向量;"lexical" = 本地词法回退(UI 必须如实标注) */
  mode: "lexical" | "api";
  hits: SimilarContentHit[];
  candidateCount: number;
  elapsedMs: number;
}

export interface EmbeddingStatus {
  space: {
    id: string;
    provider: string;
    model: string;
    mode: string;
    dimension: number;
  } | null;
  embeddings: {
    textHash: string;
    superseded: boolean;
    createdAt: string;
    dimension: number;
    provider: string;
    model: string;
  }[];
  semanticText: {
    semanticText: string;
    textHash: string;
    textBuilderVersion: string;
    wasTruncated: boolean;
  } | null;
}
