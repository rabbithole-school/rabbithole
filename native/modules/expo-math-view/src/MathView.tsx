import { requireNativeView } from 'expo';
import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import type { MathViewProps } from './MathView.types';

type NativeSizeEvent = { nativeEvent: { width: number; height: number } };
type NativeMathViewProps = MathViewProps & {
  onSizeChange?: (event: NativeSizeEvent) => void;
  style?: StyleProp<ViewStyle>;
};

const NativeView: React.ComponentType<NativeMathViewProps> =
  requireNativeView('ExpoMathView');

/**
 * Native LaTeX renderer (iPad). Backed by SwiftMath's `MTMathUILabel`, vendored
 * into the ExpoMathView pod and rendered in the Fira Math face. On web this
 * resolves to `MathView.web.tsx` (the lite RN renderer).
 *
 * A native view has no intrinsic size in React Native's Yoga layout, so the
 * Swift side measures the typeset content and emits `onSizeChange`; we hold that
 * size in state and apply it, letting the glyphs flow inline within tutor prose.
 */
export default function MathView(props: MathViewProps) {
  const { fontSize = 28, style, ...rest } = props;
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);

  const onSizeChange = React.useCallback((event: NativeSizeEvent) => {
    const { width, height } = event.nativeEvent;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    setSize((prev) =>
      prev && Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5
        ? prev
        : { width, height },
    );
  }, []);

  return (
    <NativeView
      {...rest}
      fontSize={fontSize}
      onSizeChange={onSizeChange}
      // Before the first measurement, reserve a line-height-tall sliver so the
      // view participates in layout and gets a chance to measure/report.
      style={[style, size ?? { width: 1, height: fontSize * 1.2 }]}
    />
  );
}
