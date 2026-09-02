"use client";

import { useState } from "react";
import { useServerInsertedHTML } from "next/navigation";
import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";

/**
 * SSR cache registry for Emotion (which Chakra v3 styles through).
 *
 * Without this, Emotion only inserts its styles — including the global
 * reset under `data-emotion="css-global"` — on the client. They're absent
 * from the server-rendered HTML, so React reports a hydration mismatch on
 * first paint (most visibly on /teacher). `useServerInsertedHTML` flushes
 * the styles Emotion inserted during render into the streamed <head>, so
 * server and client markup agree.
 *
 * Pattern from Chakra UI's Next.js App Router guide.
 */
export function EmotionRegistry({ children }: { children: React.ReactNode }) {
  const [cache] = useState(() => {
    const c = createCache({ key: "css" });
    // Track inserted names so useServerInsertedHTML can emit only what's new.
    c.compat = true;
    const prevInsert = c.insert;
    let inserted: string[] = [];
    c.insert = (...args) => {
      const serialized = args[1];
      if (c.inserted[serialized.name] === undefined) {
        inserted.push(serialized.name);
      }
      return prevInsert(...args);
    };
    const flush = () => {
      const prev = inserted;
      inserted = [];
      return prev;
    };
    return { cache: c, flush };
  });

  useServerInsertedHTML(() => {
    const names = cache.flush();
    if (names.length === 0) return null;
    let styles = "";
    for (const name of names) {
      styles += cache.cache.inserted[name];
    }
    return (
      <style
        data-emotion={`${cache.cache.key} ${names.join(" ")}`}
        dangerouslySetInnerHTML={{ __html: styles }}
      />
    );
  });

  return <CacheProvider value={cache.cache}>{children}</CacheProvider>;
}
