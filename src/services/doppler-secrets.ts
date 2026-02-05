/**
 * Secrets manager for V3 standalone
 * Re-exports from main app's doppler-secrets service for unified secret access
 */

// Try to import from main app's doppler-secrets service first
// Falls back to local process.env if import fails
let mainSecrets: any = null;

try {
  // Dynamic import to handle cases where main app isn't available
  mainSecrets = require('../../../src/services/doppler-secrets').secrets;
} catch (e) {
  // Fallback for standalone mode
  console.log('[V3 Secrets] Using standalone secrets manager (main app not available)');
}

class SecretsManager {
  private cache: Map<string, string> = new Map();

  get(key: string): string | undefined {
    // First try main app's secrets service
    if (mainSecrets && typeof mainSecrets.get === 'function') {
      const value = mainSecrets.get(key);
      if (value) return value;
    }

    // Then check cache
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }

    // Finally check environment
    const value = process.env[key];
    if (value) {
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: string): void {
    this.cache.set(key, value);
    // Also set in main if available
    if (mainSecrets && typeof mainSecrets.set === 'function') {
      mainSecrets.set(key, value);
    }
  }

  has(key: string): boolean {
    if (mainSecrets && typeof mainSecrets.has === 'function') {
      return mainSecrets.has(key);
    }
    return this.cache.has(key) || !!process.env[key];
  }
}

export const secrets = new SecretsManager();
