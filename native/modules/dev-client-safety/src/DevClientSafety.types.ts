import { NativeModule } from "expo-modules-core";

type DevClientSafetyModuleEvents = Record<never, never>;

export type DevClientSafetyResult = {
  guarded: boolean;
  serverUrl: string | null;
  before: string[];
  after: string[];
};

export declare class DevClientSafetyModule extends NativeModule<DevClientSafetyModuleEvents> {
  guardCurrentServer(url: string): Promise<DevClientSafetyResult>;
}
