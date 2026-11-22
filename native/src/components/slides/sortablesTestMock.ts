/**
 * A react-test-renderer stand-in for react-native-sortables, shared by the
 * editor tests (import it from a `vi.mock` factory).
 *
 * The grid renders every item through `renderItem` and hands each thumbnail
 * the same handlers a test would reach for: `onPress` is a tap, `onLongPress`
 * is a still press-and-hold (a full second) let go in place, `onShortHold`
 * lifts the thumbnail and lets go before the hold becomes a long press,
 * `onHoldThenDropAt(toIndex)` long-presses and then drags it,
 * `onDropAt(toIndex)` drags it to a new slot, and `onDragAway` drags it off the
 * grid and lets go with the order unchanged. Each thumbnail is ONE host node,
 * so `find` by testID stays unique.
 */
import { cloneElement, createElement, isValidElement, type ReactNode } from "react";
import { vi } from "vitest";

/** Runs `body` on fake timers, so a hold can last a second without waiting one. */
function withFakeTime(body: () => void) {
  const alreadyFake = vi.isFakeTimers();
  if (!alreadyFake) vi.useFakeTimers();
  try {
    body();
  } finally {
    if (!alreadyFake) vi.useRealTimers();
  }
}

type Item = { id: string };
type GridProps = {
  data: Item[];
  keyExtractor: (item: Item) => string;
  renderItem: (info: { item: Item; index: number }) => ReactNode;
  onDragStart?: (params: unknown) => void;
  onOrderChange?: (params: unknown) => void;
  onDragMove?: (params: unknown) => void;
  onDragEnd?: (params: unknown) => void;
};

export const useIsInPortalOutlet = () => false;
export const useCommonValuesContext = () => ({ touchPosition: { value: null } });

/**
 * The item's `Sortable.Touchable`, unwrapped from any single-child wrappers
 * around it, so the gesture handlers land on the node that carries its testID.
 */
function touchableIn(node: ReactNode, key: string): ReactNode {
  let el = node;
  while (
    isValidElement<{ children?: ReactNode; onTap?: unknown }>(el) &&
    el.props.onTap === undefined &&
    isValidElement(el.props.children)
  ) {
    el = el.props.children;
  }
  return isValidElement(el) ? cloneElement(el, { key }) : node;
}

function Grid({
  data,
  keyExtractor,
  renderItem,
  onDragStart,
  onOrderChange,
  onDragMove,
  onDragEnd,
}: GridProps) {
  const keys = data.map(keyExtractor);
  const drag = (fromIndex: number, toIndex: number, travel = 0, holdMs = 0) =>
    withFakeTime(() => {
      const key = keys[fromIndex];
      onDragStart?.({ key, fromIndex });
      vi.advanceTimersByTime(holdMs);
      for (const y of [0, -travel]) {
        onDragMove?.({ key, fromIndex, touchData: { absoluteX: 100, absoluteY: 300 + y } });
      }
      const indexToKey = [...keys];
      indexToKey.splice(fromIndex, 1);
      indexToKey.splice(toIndex, 0, key);
      if (toIndex !== fromIndex) onOrderChange?.({ key, fromIndex, toIndex, indexToKey });
      onDragEnd?.({ key, fromIndex, toIndex, indexToKey });
    });
  return createElement(
    "sortable-grid",
    null,
    data.map((item, index) => {
      const el = touchableIn(renderItem({ item, index }), keys[index]);
      if (!isValidElement<{ onTap?: () => void }>(el)) return el;
      return cloneElement(el, {
        key: keys[index],
        onPress: el.props.onTap,
        onLongPress: () => drag(index, index, 0, 1000),
        onShortHold: () => drag(index, index, 0, 100),
        onHoldThenDropAt: (toIndex: number) => drag(index, toIndex, 200, 1000),
        onDropAt: (toIndex: number) => drag(index, toIndex, 200),
        onDragAway: () => drag(index, index, 200),
      } as Record<string, unknown>);
    }),
  );
}

const PortalProvider = ({ children }: { children?: ReactNode }) => children ?? null;

const Sortable = { Grid, PortalProvider, Touchable: "sortable-touchable" };
export default Sortable;
