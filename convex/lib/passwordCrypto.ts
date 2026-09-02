import { Scrypt } from "lucia";
import { normalizePassword } from "../../shared/password";

/**
 * The provider-level password boundary. Hashing and verification both use the
 * same normalized value, including direct auth calls outside the UI clients.
 */
export const passwordCrypto = {
  async hashSecret(password: string): Promise<string> {
    return await new Scrypt().hash(normalizePassword(password));
  },

  async verifySecret(password: string, hash: string): Promise<boolean> {
    const scrypt = new Scrypt();
    const normalizedPassword = normalizePassword(password);
    if (await scrypt.verify(hash, normalizedPassword)) {
      return true;
    }

    // Password hashes created before normalization may include accidental
    // leading or trailing whitespace. Keep them usable until the user changes
    // their password, when hashSecret writes the normalized credential.
    return normalizedPassword !== password
      ? await scrypt.verify(hash, password)
      : false;
  },
};
