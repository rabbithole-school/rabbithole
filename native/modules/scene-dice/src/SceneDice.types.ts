import type { StyleProp, ViewStyle } from 'react-native';

export type DiceType = 'd6' | 'd20' | 'coin';

export type DiceSettledEvent = {
  /** The face-up value of each die, in the order they were created. */
  results: number[];
  /** Sum of all dice. */
  total: number;
};

export type SceneDiceViewProps = {
  /** Which polyhedron to roll — or "coin" for a heads/tails flip. Defaults to "d6". */
  diceType?: DiceType;
  /** How many dice are in the tray (1-10). Defaults to 2. */
  diceCount?: number;
  /** Hex color of the dice body, e.g. "#E9573F". */
  themeColor?: string;
  /**
   * Bump this to trigger a throw. Any change (usually an incrementing
   * integer) starts a new roll using the current throw* props.
   */
  rollToken?: number;
  /** Horizontal component of the throw direction, normalized -1..1. */
  throwX?: number;
  /** Depth component of the throw direction (toward/away), normalized -1..1. */
  throwY?: number;
  /** Throw strength multiplier, 0..1 (from swipe velocity). */
  throwPower?: number;
  /**
   * Direct manipulation: while true the dice are pinned under the finger
   * (gravity off) and follow `dragX`/`dragY`; flipping it back to false flings
   * them along the current throw* vector from wherever the finger let go.
   */
  dragActive?: boolean;
  /** Finger x while dragging, in the view's point coordinate system. */
  dragX?: number;
  /** Finger y while dragging, in the view's point coordinate system. */
  dragY?: number;
  /** Fired once the dice come to rest with their face-up values. */
  onSettled?: (event: { nativeEvent: DiceSettledEvent }) => void;
  style?: StyleProp<ViewStyle>;
};
