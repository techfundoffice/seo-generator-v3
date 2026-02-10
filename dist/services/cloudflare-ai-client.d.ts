/**
 * Cloudflare Workers AI Client
 * Replaces OpenRouter for Worker 2 with more reliable Cloudflare infrastructure
 * Uses OpenAI-compatible API endpoint for easy integration
 */
export interface CloudflareAIMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
export interface CloudflareAIOptions {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    timeout?: number;
}
export interface CloudflareAIResult {
    content: string;
    model: string;
}
/**
 * Generate text using Cloudflare Workers AI
 * Uses OpenAI-compatible chat completions endpoint
 */
export declare function generateWithCloudflareAI(prompt: string, options?: CloudflareAIOptions): Promise<CloudflareAIResult>;
/**
 * Check if Cloudflare AI is configured
 */
export declare function isCloudflareAIConfigured(): boolean;
/**
 * Get available models list
 */
export declare function getAvailableModels(): string[];
//# sourceMappingURL=cloudflare-ai-client.d.ts.map