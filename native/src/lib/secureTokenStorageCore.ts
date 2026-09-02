export type SecureStoreLike = {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
};

// SecureStore historically rejected values around 2 KB, so Convex Auth JWTs
// are chunked. The primary key is an atomic pointer: legacy `:<count>` values
// remain readable, while new writes use `:v2:<generation>:<count>` so an app
// crash cannot delete the previous token before its replacement is durable.
const CHUNK_SIZE = 1800;
const CHUNK_SENTINEL = "__rh_chunked__:";
const CHUNK_SENTINEL_V2 = `${CHUNK_SENTINEL}v2:`;

type ChunkDescriptor = {
  count: number;
  generation: string | null;
};

function splitIntoChunks(value: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += CHUNK_SIZE) {
    chunks.push(value.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
}

function parseChunkDescriptor(
  key: string,
  raw: string | null,
): ChunkDescriptor | null {
  if (raw === null || !raw.startsWith(CHUNK_SENTINEL)) return null;

  if (raw.startsWith(CHUNK_SENTINEL_V2)) {
    const [generation, countText, ...extra] = raw
      .slice(CHUNK_SENTINEL_V2.length)
      .split(":");
    const count = Number.parseInt(countText, 10);
    if (
      extra.length === 0 &&
      /^[a-zA-Z0-9_-]+$/.test(generation) &&
      /^\d+$/.test(countText) &&
      Number.isInteger(count) &&
      count > 0
    ) {
      return { count, generation };
    }
  } else {
    const countText = raw.slice(CHUNK_SENTINEL.length);
    const count = Number.parseInt(countText, 10);
    if (/^\d+$/.test(countText) && Number.isInteger(count) && count > 0) {
      return { count, generation: null };
    }
  }

  throw new Error(`Secure token metadata is corrupt for key "${key}"`);
}

function chunkKey(
  key: string,
  descriptor: ChunkDescriptor,
  index: number,
): string {
  return descriptor.generation === null
    ? `${key}.${index}`
    : `${key}.${descriptor.generation}.${index}`;
}

function defaultGeneration(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function deleteChunks(
  store: SecureStoreLike,
  key: string,
  descriptor: ChunkDescriptor,
): Promise<void> {
  await Promise.all(
    Array.from({ length: descriptor.count }, (_, index) =>
      store.deleteItemAsync(chunkKey(key, descriptor, index)),
    ),
  );
}

async function cleanupCommittedChunks(
  store: SecureStoreLike,
  key: string,
  descriptor: ChunkDescriptor | null,
): Promise<void> {
  if (descriptor === null) return;
  try {
    await deleteChunks(store, key, descriptor);
  } catch (error) {
    console.warn(
      `[secureTokenStorage] stale chunk cleanup failed for "${key}"`,
      error,
    );
  }
}

async function surfaceStorageError<T>(
  operation: "read" | "write" | "remove",
  key: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    console.error(
      `[secureTokenStorage] ${operation} failed for "${key}"`,
      error,
    );
    throw error;
  }
}

export function createSecureTokenStorage(
  store: SecureStoreLike,
  createGeneration: () => string = defaultGeneration,
) {
  return {
    getItem: (key: string): Promise<string | null> =>
      surfaceStorageError("read", key, async () => {
        const raw = await store.getItemAsync(key);
        const descriptor = parseChunkDescriptor(key, raw);
        if (descriptor === null) return raw;

        const parts = await Promise.all(
          Array.from({ length: descriptor.count }, (_, index) =>
            store.getItemAsync(chunkKey(key, descriptor, index)),
          ),
        );
        if (parts.some((part) => part === null)) {
          throw new Error(`Secure token chunks are incomplete for key "${key}"`);
        }
        return parts.join("");
      }),

    setItem: (key: string, value: string): Promise<void> =>
      surfaceStorageError("write", key, async () => {
        const previousRaw = await store.getItemAsync(key);
        const previousDescriptor = parseChunkDescriptor(key, previousRaw);

        if (value.length <= CHUNK_SIZE) {
          await store.setItemAsync(key, value);
          await cleanupCommittedChunks(store, key, previousDescriptor);
          return;
        }

        const generation = createGeneration();
        if (!/^[a-zA-Z0-9_-]+$/.test(generation)) {
          throw new Error("Secure token chunk generation is invalid");
        }
        const chunks = splitIntoChunks(value);
        const descriptor = { count: chunks.length, generation };

        // Keep the previous primary key and chunks readable until every new
        // chunk is durable. Replacing this sentinel is the atomic commit.
        await Promise.all(
          chunks.map((chunk, index) =>
            store.setItemAsync(chunkKey(key, descriptor, index), chunk),
          ),
        );
        await store.setItemAsync(
          key,
          `${CHUNK_SENTINEL_V2}${generation}:${chunks.length}`,
        );
        await cleanupCommittedChunks(store, key, previousDescriptor);
      }),

    removeItem: (key: string): Promise<void> =>
      surfaceStorageError("remove", key, async () => {
        const raw = await store.getItemAsync(key);
        const descriptor = parseChunkDescriptor(key, raw);
        await store.deleteItemAsync(key);
        await cleanupCommittedChunks(store, key, descriptor);
      }),
  };
}
