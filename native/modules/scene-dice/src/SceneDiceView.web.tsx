import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { SceneDiceViewProps } from './SceneDice.types';

export default function SceneDiceView(props: SceneDiceViewProps) {
  return (
    <View style={[styles.fallback, props.style]}>
      <Text style={styles.text}>3D dice run in the iPad app.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: { alignItems: 'center', justifyContent: 'center' },
  text: { color: '#64748b', fontSize: 16 },
});
