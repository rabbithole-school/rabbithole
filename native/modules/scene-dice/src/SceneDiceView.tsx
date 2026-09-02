import { requireNativeView } from 'expo';
import * as React from 'react';

import type { SceneDiceViewProps } from './SceneDice.types';

const NativeView: React.ComponentType<SceneDiceViewProps> =
  requireNativeView('SceneDice');

export default function SceneDiceView(props: SceneDiceViewProps) {
  return <NativeView {...props} />;
}
