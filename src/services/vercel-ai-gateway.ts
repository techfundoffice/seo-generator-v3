import Anthropic from '@anthropic-ai/sdk';

/**
 * Vercel AI Gateway wrapper for Claude Max/Pro subscription
 * Routes requests through Vercel's AI Gateway using your existing Claude subscription
 * No additional API costs - uses flat monthly Max/Pro rate
 */

export class VercelAIGateway {
  private client: Anthropic;

  constructor() {
    const gatewayKey = process.env.AI_GATEWAY_API_KEY;

    if (!gatewayKey) {
      throw new Error('AI_GATEWAY_API_KEY environment variable is required');
    }

    this.client = new Anthropic({
      apiKey: gatewayKey,
      baseURL: 'https://ai-gateway.vercel.sh',
      defaultHeaders: {
        'x-ai-gateway-api-key': `Bearer ${gatewayKey}`,
      },
    });
  }

  /**
   * Generate content using Claude Sonnet 4.5 via Vercel AI Gateway
   * @param userPrompt - The user's prompt/request
   * @param systemPrompt - System instructions for the AI
   * @param maxTokens - Maximum tokens to generate (default: 16000 for long article content)
   * @returns Generated text content
   */
  async generateContent(
    userPrompt: string,
    systemPrompt: string,
    maxTokens: number = 16000
  ): Promise<string> {
    try {
      console.log('[Vercel AI Gateway] Generating content with Claude Sonnet 4.5');

      const response = await this.client.messages.create({
        model: 'anthropic/claude-sonnet-4.5',
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userPrompt,
          },
        ],
      });

      const textContent = response.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('\n');

      console.log(`[Vercel AI Gateway] Generated ${textContent.length} characters`);

      return textContent;
    } catch (error: any) {
      console.error('[Vercel AI Gateway] Error:', error.message);
      throw new Error(`Vercel AI Gateway failed: ${error.message}`);
    }
  }
}

/**
 * Singleton instance for reuse across requests
 */
let gatewayInstance: VercelAIGateway | null = null;

export function getVercelAIGateway(): VercelAIGateway {
  if (!gatewayInstance) {
    gatewayInstance = new VercelAIGateway();
  }
  return gatewayInstance;
}

/**
 * Convenience function - drop-in wrapper for Claude via Vercel AI Gateway
 * @param userPrompt - The prompt to send
 * @param systemPrompt - Optional system prompt (defaults to SEO content writer)
 * @param maxTokens - Max tokens (default: 16000 for long-form content)
 */
export async function vercelAI(
  userPrompt: string,
  systemPrompt: string = 'You are an expert SEO content writer. Return only valid JSON as instructed.',
  maxTokens: number = 16000
): Promise<string> {
  const gateway = getVercelAIGateway();
  return gateway.generateContent(userPrompt, systemPrompt, maxTokens);
}
