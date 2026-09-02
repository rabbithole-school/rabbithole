import * as SecureStore from "expo-secure-store";

import { createSecureTokenStorage } from "@/lib/secureTokenStorageCore";

export const secureTokenStorage = createSecureTokenStorage(SecureStore);
