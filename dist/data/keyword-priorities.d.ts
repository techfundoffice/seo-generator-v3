/**
 * Keyword Priority System
 *
 * Prioritizes keywords based on:
 * - Search volume potential (estimated)
 * - Commercial intent (buyer keywords)
 * - Competition level
 *
 * Priority Tiers:
 * 1. HIGH: High-volume, high-intent keywords (best pet insurance, cost, comparison)
 * 2. MEDIUM: Breed-specific, condition-specific keywords
 * 3. LOW: Long-tail, niche keywords
 */
export type PriorityTier = 'high' | 'medium' | 'low';
export interface PrioritizedKeyword {
    keyword: string;
    slug: string;
    priority: PriorityTier;
    score: number;
    category: string;
}
export declare function getPrioritizedKeywords(): PrioritizedKeyword[];
export declare function getKeywordsByPriority(tier: PriorityTier): PrioritizedKeyword[];
export declare function getNextKeyword(existingSlugs: Set<string>): PrioritizedKeyword | null;
export declare function getKeywordStats(): {
    total: number;
    byPriority: Record<PriorityTier, number>;
    byCategory: Record<string, number>;
};
export declare function getTopKeywords(n?: number): {
    high: PrioritizedKeyword[];
    medium: PrioritizedKeyword[];
    low: PrioritizedKeyword[];
};
//# sourceMappingURL=keyword-priorities.d.ts.map