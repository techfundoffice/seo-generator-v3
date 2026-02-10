/**
 * Secrets manager for V3 standalone
 * Re-exports from main app's doppler-secrets service for unified secret access
 */
declare class SecretsManager {
    private cache;
    private debugLogged;
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    has(key: string): boolean;
}
export declare const secrets: SecretsManager;
export {};
//# sourceMappingURL=doppler-secrets.d.ts.map