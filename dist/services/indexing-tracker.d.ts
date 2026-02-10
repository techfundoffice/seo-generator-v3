/**
 * Indexing Tracker Service for SEO Generator V3
 * Autonomous system for tracking, verifying, and retrying Google indexing
 * NO CRON JOBS - Integrates into V3 autonomous flow
 */
interface IndexQueueItem {
    url: string;
    slug: string;
    category: string;
    createdAt: string;
    lastCheckedAt: string | null;
    checkCount: number;
    retryCount: number;
    status: 'pending' | 'checking' | 'indexed' | 'failed' | 'retry_scheduled';
    lastError?: string;
    indexedAt?: string;
}
interface IndexStats {
    totalTracked: number;
    indexed: number;
    pending: number;
    failed: number;
    avgTimeToIndex: number;
    lastUpdated: string;
}
interface IndexHistory {
    url: string;
    slug: string;
    indexedAt: string;
    timeToIndex: number;
}
export declare function initKVConfig(accountId: string, namespaceId: string, apiToken: string): void;
/**
 * Initialize tracker - load existing queue from KV
 */
export declare function initIndexTracker(): Promise<void>;
/**
 * Add new article to indexing queue
 * Called immediately after article generation
 */
export declare function trackNewArticle(url: string, slug: string, category: string): Promise<void>;
/**
 * Process indexing queue - called during V3 autonomous cycle
 * Returns items that were processed for activity logging
 */
export declare function processIndexQueue(): Promise<{
    checked: number;
    indexed: number;
    retried: number;
    failed: number;
    results: Array<{
        url: string;
        slug: string;
        status: string;
        message: string;
    }>;
}>;
/**
 * Get current indexing status for dashboard
 */
export declare function getIndexStatus(): {
    stats: IndexStats;
    queue: IndexQueueItem[];
    recentHistory: IndexHistory[];
};
/**
 * Get pending items count (for autonomous loop decision making)
 */
export declare function getPendingCount(): number;
/**
 * Force re-check a specific URL
 */
export declare function forceRecheck(url: string): Promise<{
    success: boolean;
    message: string;
}>;
/**
 * Clear completed/failed items older than 30 days
 */
export declare function cleanupOldItems(): Promise<number>;
export {};
//# sourceMappingURL=indexing-tracker.d.ts.map