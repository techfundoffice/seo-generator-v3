/**
 * Cloudflare Workers AI Client
 * Replaces OpenRouter for Worker 2 with more reliable Cloudflare infrastructure
 * Uses OpenAI-compatible API endpoint for easy integration
 */

import { secrets } from './doppler-secrets';
import { vercelAI } from './vercel-ai-gateway';

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

// Use Llama 4 Scout - Meta's best premium model with MoE architecture
const DEFAULT_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const FALLBACK_MODELS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',  // Best: Llama 4 Scout - 17B with 16 experts MoE
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast', // Fallback: 70B optimized for speed
  '@cf/mistralai/mistral-small-3.1-24b-instruct', // Fallback: 128K context
  '@cf/google/gemma-3-12b-it'                 // Fallback: Google Gemma 3
];

export interface CloudflareAIResult {
  content: string;
  model: string;
}

/**
 * Generate text using Cloudflare Workers AI
 * Uses OpenAI-compatible chat completions endpoint
 */
export async function generateWithCloudflareAI(
  prompt: string,
  options: CloudflareAIOptions = {}
): Promise<CloudflareAIResult> {
  // Try Claude via Vercel AI Gateway first (primary provider)
  try {
    console.log('[V3] Using Vercel AI Gateway (Claude Sonnet 4.5)');
    const maxTokens = options.maxTokens || 16000;
    const result = await vercelAI(prompt, undefined, maxTokens);
    return { content: result, model: 'claude-sonnet-4.5' };
  } catch (error: any) {
    console.warn(`[V3] Vercel AI Gateway failed: ${error.message}, falling back to Cloudflare AI`);
  }

  // Fallback: Cloudflare AI cascade
  const accountId = secrets.get('CLOUDFLARE_ACCOUNT_ID') || process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  const globalApiKey = secrets.get('CLOUDFLARE_GLOBAL_API_KEY') || process.env.CLOUDFLARE_GLOBAL_API_KEY;
  const cfEmail = secrets.get('CLOUDFLARE_EMAIL') || process.env.CLOUDFLARE_EMAIL;

  // Determine which auth method to use
  const useGlobalKey = !!(globalApiKey && cfEmail);
  const authHeaders: Record<string, string> = useGlobalKey 
    ? { 'X-Auth-Email': cfEmail!, 'X-Auth-Key': globalApiKey! }
    : { 'Authorization': `Bearer ${apiToken}` };

  console.log(`☁️ [Cloudflare AI] Using ${useGlobalKey ? 'Global API Key' : 'API Token'} auth (email: ${cfEmail ? cfEmail.substring(0, 5) + '...' : 'none'})`);

  if (!accountId || (!apiToken && !useGlobalKey)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID and (CLOUDFLARE_API_TOKEN or CLOUDFLARE_GLOBAL_API_KEY+EMAIL) not found');
  }

  const {
    model = DEFAULT_MODEL,
    maxTokens = 16000,
    temperature = 0.7,
    timeout = 600000
  } = options;

  const modelsToTry = model === DEFAULT_MODEL ? FALLBACK_MODELS : [model, ...FALLBACK_MODELS];
  let lastError: Error | null = null;

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

      const response = await fetch(
        endpoint,
        {
          method: 'POST',
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`⚠️ [Cloudflare AI] ${currentModel} failed: ${response.status} - ${errorText.substring(0, 200)}`);
        lastError = new Error(`Cloudflare AI ${currentModel}: ${response.status}`);
        continue;
      }

      const data = await response.json() as any;
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

    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log(`⚠️ [Cloudflare AI] ${currentModel} timed out`);
        lastError = new Error(`Cloudflare AI ${currentModel}: Timeout`);
      } else {
        console.log(`⚠️ [Cloudflare AI] ${currentModel} error: ${error.message}`);
        lastError = error;
      }
      continue;
    }
  }

  throw lastError || new Error('All Cloudflare AI models failed');
}

/**
 * Check if Cloudflare AI is configured
 */
export function isCloudflareAIConfigured(): boolean {
  return !!(secrets.get('CLOUDFLARE_ACCOUNT_ID') && secrets.get('CLOUDFLARE_API_TOKEN'));
}

/**
 * Get available models list
 */
export function getAvailableModels(): string[] {
  return FALLBACK_MODELS;
}
