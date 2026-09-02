import { NativeModule } from "expo-modules-core";

type ManagedConfigModuleEvents = Record<never, never>;

export declare class ManagedConfigModule extends NativeModule<ManagedConfigModuleEvents> {
  getManagedConfig(): Record<string, unknown> | null;
}
