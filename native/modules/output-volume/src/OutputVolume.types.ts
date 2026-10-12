import { NativeModule } from "expo-modules-core";

export type OutputVolumeChangeEvent = {
  /** The system output volume, 0…1. */
  volume: number;
};

export type OutputVolumeModuleEvents = {
  onChange: (event: OutputVolumeChangeEvent) => void;
};

// Declared class shape (the Expo Modules convention, as in hardware-keyboard):
// extending `NativeModule` provides `addListener`/`removeListener`.
export declare class OutputVolumeModule extends NativeModule<OutputVolumeModuleEvents> {
  /** Point-in-time read of the system output volume (0…1). */
  getVolume(): number;
}
