// The one text-embedding service the maps use: OpenAI text-embedding-3-small
// at 512 dimensions, which keeps a vector small enough to store in a side
// table and to read back for one cosine pass. Callers: the concept atlas
// (conceptAtlas.ts), the Skills map (practiceAtlas.ts) and a scholar's own
// sky (skyStars.ts). Plain fetch, so any action runtime can call it.
//
// Errors carry fixed words and at most a status: a provider's error body can
// echo the request, including the key, and errors reach logs.

export const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIMS = 512;
/** The most inputs one embeddings request takes here. */
export const EMBED_BATCH_SIZE = 128;
/** How much of one text is sent: a bound well inside the model's window. */
export const EMBED_TEXT_MAX_CHARS = 1000;
/** One request, answer included, gives up after this long, so a slow
 *  provider can't hold a caller (the Sky backfill runs many kids in one
 *  action) until its time runs out. */
export const EMBED_TIMEOUT_MS = 30_000;

/** The messages an embedding failure can carry: no body, no key. */
export const EMBED_TIMEOUT_MESSAGE = `OpenAI embeddings request timed out after ${EMBED_TIMEOUT_MS / 1000} s`;
export const EMBED_NETWORK_MESSAGE = "OpenAI embeddings request failed without a usable answer";

/** One request: one vector per text, in the order given. */
export async function embedBatch(
  texts: string[],
  apiKey: string,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS }),
      signal: abort.signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`OpenAI embeddings request failed with status ${res.status}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => d.embedding);
  } catch (error) {
    if (abort.signal.aborted) throw new Error(EMBED_TIMEOUT_MESSAGE);
    if (error instanceof Error && error.message.startsWith("OpenAI embeddings")) throw error;
    throw new Error(EMBED_NETWORK_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
}

/** Every text embedded, EMBED_BATCH_SIZE at a time, each cut to
 *  EMBED_TEXT_MAX_CHARS. One vector per text, in order. */
export async function embedTexts(
  texts: string[],
  apiKey: string,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts
      .slice(i, i + EMBED_BATCH_SIZE)
      .map((text) => text.slice(0, EMBED_TEXT_MAX_CHARS));
    vectors.push(...(await embedBatch(batch, apiKey)));
  }
  return vectors;
}

/** The deployment's OpenAI key, or a legible error when it is not set. */
export function requireEmbeddingKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not set on this deployment");
  return key;
}
