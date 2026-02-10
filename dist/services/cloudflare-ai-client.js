"use strict";
/**
 * Cloudflare Workers AI Client
 * Replaces OpenRouter for Worker 2 with more reliable Cloudflare infrastructure
 * Uses OpenAI-compatible API endpoint for easy integration
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAvailableModels = exports.isCloudflareAIConfigured = exports.generateWithCloudflareAI = void 0;
const doppler_secrets_1 = require("./doppler-secrets");
// Use Llama 4 Scout - Meta's best premium model with MoE architecture
const DEFAULT_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const FALLBACK_MODELS = [
    '@cf/meta/llama-4-scout-17b-16e-instruct',
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    '@cf/mistralai/mistral-small-3.1-24b-instruct',
    '@cf/google/gemma-3-12b-it' // Fallback: Google Gemma 3
];
/**
 * Generate text using Cloudflare Workers AI
 * Uses OpenAI-compatible chat completions endpoint
 */
async function generateWithCloudflareAI(prompt, options = {}) {
    const accountId = doppler_secrets_1.secrets.get('CLOUDFLARE_ACCOUNT_ID') || process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = doppler_secrets_1.secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
    const globalApiKey = doppler_secrets_1.secrets.get('CLOUDFLARE_GLOBAL_API_KEY') || process.env.CLOUDFLARE_GLOBAL_API_KEY;
    const cfEmail = doppler_secrets_1.secrets.get('CLOUDFLARE_EMAIL') || process.env.CLOUDFLARE_EMAIL;
    // Determine which auth method to use
    const useGlobalKey = !!(globalApiKey && cfEmail);
    const authHeaders = useGlobalKey
        ? { 'X-Auth-Email': cfEmail, 'X-Auth-Key': globalApiKey }
        : { 'Authorization': `Bearer ${apiToken}` };
    console.log(`☁️ [Cloudflare AI] Using ${useGlobalKey ? 'Global API Key' : 'API Token'} auth (email: ${cfEmail ? cfEmail.substring(0, 5) + '...' : 'none'})`);
    if (!accountId || (!apiToken && !useGlobalKey)) {
        throw new Error('CLOUDFLARE_ACCOUNT_ID and (CLOUDFLARE_API_TOKEN or CLOUDFLARE_GLOBAL_API_KEY+EMAIL) not found');
    }
    const { model = DEFAULT_MODEL, maxTokens = 16000, temperature = 0.7, timeout = 600000 } = options;
    const modelsToTry = model === DEFAULT_MODEL ? FALLBACK_MODELS : [model, ...FALLBACK_MODELS];
    let lastError = null;
    for (const currentModel of modelsToTry) {
        try {
            console.log(`☁️ [Cloudflare AI] Trying ${currentModel}...`);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            // Use /ai/run/ endpoint for Global API Key auth, /ai/v1/chat/completions for API Token
            const endpoint = useGlobalKey
                ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${currentModel}`
                : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
            const requestBody = useGlobalKey
                ? { messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }
                : { model: currentModel, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature: temperature };
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    ...authHeaders,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                const errorText = await response.text();
                console.log(`⚠️ [Cloudflare AI] ${currentModel} failed: ${response.status} - ${errorText.substring(0, 200)}`);
                lastError = new Error(`Cloudflare AI ${currentModel}: ${response.status}`);
                continue;
            }
            const data = await response.json();
            // Handle both /ai/run/ format (result.response) and OpenAI format (choices[0].message.content)
            const content = useGlobalKey
                ? data.result?.response
                : data.choices?.[0]?.message?.content;
            if (!content) {
                console.log(`⚠️ [Cloudflare AI] ${currentModel} returned empty content`);
                lastError = new Error(`Cloudflare AI ${currentModel}: Empty response`);
                continue;
            }
            // Extract short model name for display
            const shortModel = currentModel.split('/').pop() || currentModel;
            console.log(`✅ [Cloudflare AI] ${shortModel} responded (${content.length} chars)`);
            return { content, model: shortModel };
        }
        catch (error) {
            if (error.name === 'AbortError') {
                console.log(`⚠️ [Cloudflare AI] ${currentModel} timed out`);
                lastError = new Error(`Cloudflare AI ${currentModel}: Timeout`);
            }
            else {
                console.log(`⚠️ [Cloudflare AI] ${currentModel} error: ${error.message}`);
                lastError = error;
            }
            continue;
        }
    }
    throw lastError || new Error('All Cloudflare AI models failed');
}
exports.generateWithCloudflareAI = generateWithCloudflareAI;
/**
 * Check if Cloudflare AI is configured
 */
function isCloudflareAIConfigured() {
    return !!(doppler_secrets_1.secrets.get('CLOUDFLARE_ACCOUNT_ID') && doppler_secrets_1.secrets.get('CLOUDFLARE_API_TOKEN'));
}
exports.isCloudflareAIConfigured = isCloudflareAIConfigured;
/**
 * Get available models list
 */
function getAvailableModels() {
    return FALLBACK_MODELS;
}
exports.getAvailableModels = getAvailableModels;
//# sourceMappingURL=cloudflare-ai-client.js.map