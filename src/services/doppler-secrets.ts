/**
 * Secrets manager for V3 standalone
 * Re-exports from main app's doppler-secrets service for unified secret access
 */

// Try to import from main app's doppler-secrets service first
// Falls back to local process.env if import fails
let mainSecrets: any = null;

try {
  // Dynamic import to handle cases where main app isn't available
  // Try multiple paths because the relative path can vary based on execution context
  try {
    mainSecrets = require('../../../src/services/doppler-secrets').secrets;
  } catch {
    // Try alternative path for when running from main app
    try {
      const path = require('path');
      const mainAppRoot = path.resolve(__dirname, '../../../../');
      mainSecrets = require(path.join(mainAppRoot, 'src/services/doppler-secrets')).secrets;
    } catch {
      // Try via node_modules resolution
      console.log('[V3 Secrets] Could not find main app secrets service, using environment');
    }
  }
} catch (e) {
  // Fallback for standalone mode
  console.log('[V3 Secrets] Using standalone secrets manager (main app not available)');
}

class SecretsManager {
  private cache: Map<string, string> = new Map();
  private debugLogged = false;

  get(key: string): string | undefined {
    // Debug: Log first secret access to verify config
    if (!this.debugLogged && key.startsWith('CLOUDFLARE')) {
      console.log(`[V3 Secrets Debug] First CLOUDFLARE access - mainSecrets available: ${!!mainSecrets}`);
      console.log(`[V3 Secrets Debug] CLOUDFLARE_ACCOUNT_ID in env: ${!!process.env.CLOUDFLARE_ACCOUNT_ID}`);
      console.log(`[V3 Secrets Debug] CLOUDFLARE_API_TOKEN in env: ${!!process.env.CLOUDFLARE_API_TOKEN}`);
      this.debugLogged = true;
    }

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
