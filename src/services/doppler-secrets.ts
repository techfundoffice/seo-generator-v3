/**
 * Secrets manager for V3 standalone
 * In production, replace with actual Doppler or environment variable handling
 */

class SecretsManager {
  private cache: Map<string, string> = new Map();

  get(key: string): string | undefined {
    // First check cache
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    // Then check environment
    const value = process.env[key];
    if (value) {
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key) || !!process.env[key];
  }
}

export const secrets = new SecretsManager();
