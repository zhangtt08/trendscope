/**
 * Vector math & serialization (Stage 6A §19/§20).
 * Float32 BLOB 序列化;dimension 严格校验;cosine 全边界处理。
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`cosine rejected non-finite component at index ${i}`);
    }
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0; // zero vector 安全处理:相似度 0(§20)
  const d = dot / (Math.sqrt(na) * Math.sqrt(nb));
  // 浮点噪声夹紧到 [-1, 1]
  return Math.max(-1, Math.min(1, d));
}

/** Float32Array → BLOB(Buffer)。写入前校验有限性。 */
export function serializeVector(vec: readonly number[]): Buffer {
  const f32 = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    if (!Number.isFinite(v)) {
      throw new Error(`vector contains non-finite component at index ${i}`);
    }
    f32[i] = v;
  }
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** BLOB → number[]。length 必须等于声明的 dimension(§19),否则明确报错。 */
export function deserializeVector(blob: Buffer, dimension: number): number[] {
  if (blob.byteLength !== dimension * 4) {
    throw new Error(
      `vector dimension mismatch: blob is ${blob.byteLength} bytes (${blob.byteLength / 4} floats) but space declares ${dimension}`,
    );
  }
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, dimension);
  const out = new Array<number>(dimension);
  for (let i = 0; i < dimension; i++) {
    out[i] = f32[i];
    if (!Number.isFinite(out[i])) {
      throw new Error(`stored vector has non-finite component at index ${i}`);
    }
  }
  return out;
}

/** §16 EmbeddingSpace 稳定 ID:`{providerId}:{model}:{dimension}:{textBuilderVersion}` */
export function embeddingSpaceId(
  providerId: string,
  model: string,
  dimension: number,
  textBuilderVersion: string,
): string {
  for (const part of [providerId, model, textBuilderVersion]) {
    if (part.includes(":")) {
      throw new Error(`embedding space id segment must not contain ":": ${part}`);
    }
  }
  return `${providerId}:${model}:${dimension}:${textBuilderVersion}`;
}
