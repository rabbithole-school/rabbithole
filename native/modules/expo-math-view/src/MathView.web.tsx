import * as React from 'react';

import type { MathViewProps } from './MathView.types';
// The native module's web fallback simply reuses the cross-platform lite
// renderer (RN primitives → works under react-native-web too), so Expo-web
// builds still get proper stacked fractions with the brand font.
import { MathText } from '@/components/MathText';

export default function MathView(props: MathViewProps) {
  return (
    <MathText
      latex={props.latex}
      fontSize={props.fontSize ?? 28}
      color={props.color}
      align="left"
    />
  );
}
