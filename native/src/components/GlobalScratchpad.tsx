/**
 * Canonical host for the native Scratchpad. Rabbit Slides mounts this once in
 * its full-screen editor so slide insertion can reuse the existing paper,
 * capture renderer, and transport instead of growing a second sketch surface.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { Scratchpad } from "@/components/Scratchpad";
import { scratchpadBus, type SilentCapture } from "@/lib/scratchpadBus";

export function GlobalScratchpad({ title = "Scratchpad" }: { title?: string }) {
  const [open, setOpen] = useState(false);

  // The LIVE send destination's button copy, and the fresh-paper counter. Both
  // are read as external-store snapshots rather than mirrored into state by an
  // effect: a screen's `useFocusEffect` registers its target BEFORE this
  // component's effects run (children commit before later siblings), so an
  // effect-based subscription misses the very first registration and the send
  // button never appears on a cold launch straight into a tutor session.
  const label = useSyncExternalStore(
    scratchpadBus.subscribeTarget,
    scratchpadBus.getPrimaryLabel,
  );
  const sheetKey = useSyncExternalStore(
    scratchpadBus.subscribeClear,
    scratchpadBus.getSheetSerial,
  );
  useEffect(() => scratchpadBus.subscribe(() => setOpen(true)), []);
  useEffect(() => scratchpadBus.subscribeClose(() => setOpen(false)), []);

  const onCapture = useCallback(async (uri: string, mime: string) => {
    const t = scratchpadBus.getTarget();
    if (t?.onCapture) {
      await t.onCapture(uri, mime);
      scratchpadBus.clearTarget(t);
    }
    // No target → pure scratch space; nothing to send. Strokes persist in the pad.
  }, []);

  const close = useCallback(() => {
    scratchpadBus.close();
  }, []);

  useEffect(() => () => scratchpadBus.cancelTarget(), []);

  // The pad publishes its renderer; the bus is how a surface reaches it (see
  // `requestCapture`). Kept here rather than inside Scratchpad so the pad stays
  // a plain props-in component with no knowledge of the bus, same as onCapture.
  const registerCapture = useCallback(
    (fn: SilentCapture | null, prev?: SilentCapture) =>
      scratchpadBus.setCaptureProvider(fn, prev),
    [],
  );

  return (
    <Scratchpad
      visible={open}
      onClose={close}
      onCapture={onCapture}
      primaryLabel={label}
      sheetKey={sheetKey}
      registerCapture={registerCapture}
      title={title}
    />
  );
}

export default GlobalScratchpad;
