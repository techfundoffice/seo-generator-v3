import Anthropic from '@anthropic-ai/sdk';
import { secrets } from './doppler-secrets';

/**
 * Vercel AI Gateway wrapper for Claude
 *
 * Strategy 1 (primary): Use Claude Max subscription via ai-sdk-provider-claude-code
 *   - Routes through Claude Code CLI's OAuth session
 *   - No per-token API costs (uses flat monthly Max/Pro rate)
 *   - Requires `claude` CLI to be logged in
 *
 * Strategy 2 (fallback): Use Anthropic API key via Vercel AI Gateway
 *   - Uses AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY from Doppler
 *   - Per-token billing against API credits
 */

/**
 * Strategy 1: Generate via Claude Max subscription (ai-sdk-provider-claude-code)
 * Uses the Claude Code CLI's existing auth session — no API key costs
 */
async function generateViaClaudeMax(
  userPrompt: string,
  systemPrompt: string,
  maxTokens: number
): Promise<string> {
  const { claudeCode } = await import('ai-sdk-provider-claude-code');
  const { generateText } = await import('ai');

  console.log('[Vercel AI Gateway] Using Claude Max subscription (ai-sdk-provider-claude-code)');

  const { text } = await generateText({
    model: claudeCode('sonnet', {
      maxTurns: 1,
      permissionMode: 'bypassPermissions' as any,
    }),
    prompt: systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt,
    maxOutputTokens: maxTokens,
  });

  if (!text || text.length === 0) {
    throw new Error('Claude Max returned empty response');
  }

  console.log(`[Vercel AI Gateway] Claude Max generated ${text.length} characters`);
  return text;
}

/**
 * Strategy 2: Generate via Anthropic API key through Vercel AI Gateway
 */
async function generateViaApiKey(
  userPrompt: string,
  systemPrompt: string,
  maxTokens: number
): Promise<string> {
  const gatewayKey = secrets.get('AI_GATEWAY_API_KEY') || process.env.AI_GATEWAY_API_KEY
    || secrets.get('ANTHROPIC_API_KEY') || process.env.ANTHROPIC_API_KEY;

  if (!gatewayKey) {
    throw new Error('No AI_GATEWAY_API_KEY or ANTHROPIC_API_KEY available for API fallback');
  }

  console.log('[Vercel AI Gateway] Using API key via Vercel AI Gateway');

  const client = new Anthropic({
    apiKey: gatewayKey,
    baseURL: 'https://ai-gateway.vercel.sh',
    defaultHeaders: {
      'x-ai-gateway-api-key': `Bearer ${gatewayKey}`,
    },
  });

  const response = await client.messages.create({
    model: 'anthropic/claude-sonnet-4.5',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textContent = response.content
    .filter((block: any) => block.type === 'text')
    .map((block: any) => block.text)
    .join('\n');

  console.log(`[Vercel AI Gateway] API key generated ${textContent.length} characters`);
  return textContent;
}

/**
 * Convenience function - drop-in wrapper for Claude via Vercel AI Gateway
 * Tries Claude Max subscription first, falls back to API key
 */
export async function vercelAI(
  userPrompt: string,
  systemPrompt: string = 'You are an expert SEO content writer. Return only valid JSON as instructed.',
  maxTokens: number = 16000
): Promise<string> {
  // Strategy 1: Claude Max subscription (no API costs)
  try {
    return await generateViaClaudeMax(userPrompt, systemPrompt, maxTokens);
  } catch (error: any) {
    console.warn(`[Vercel AI Gateway] Claude Max failed: ${error.message}, trying API key fallback`);
  }

  // Strategy 2: API key via Vercel AI Gateway
  try {
    return await generateViaApiKey(userPrompt, systemPrompt, maxTokens);
  } catch (error: any) {
    console.warn(`[Vercel AI Gateway] API key fallback failed: ${error.message}`);
    throw new Error(`All Vercel AI Gateway strategies failed. Last error: ${error.message}`);
  }
}
