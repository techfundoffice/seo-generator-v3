"use strict";
/**
 * Indexing Tracker Service for SEO Generator V3
 * Autonomous system for tracking, verifying, and retrying Google indexing
 * NO CRON JOBS - Integrates into V3 autonomous flow
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanupOldItems = exports.forceRecheck = exports.getPendingCount = exports.getIndexStatus = exports.processIndexQueue = exports.trackNewArticle = exports.initIndexTracker = exports.initKVConfig = void 0;
const google_search_console_1 = require("./google-search-console");
// KV Keys for indexing tracker
const KV_INDEX_QUEUE = 'indexing:queue';
const KV_INDEX_STATS = 'indexing:stats';
const KV_INDEX_HISTORY = 'indexing:history';
// Configuration
const INDEX_CHECK_DELAY_HOURS = 24; // Wait 24h before first check
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_INTERVAL_HOURS = 48; // Wait 48h between retries
const BATCH_CHECK_SIZE = 10; // Check 10 URLs per autonomous cycle
// In-memory queue (synced to KV)
let indexQueue = new Map();
let indexStats = {
    totalTracked: 0,
    indexed: 0,
    pending: 0,
    failed: 0,
    avgTimeToIndex: 0,
    lastUpdated: new Date().toISOString()
};
let indexHistory = [];
let isProcessing = false;
// Cloudflare KV helpers
let kvConfig = null;
function initKVConfig(accountId, namespaceId, apiToken) {
    kvConfig = { accountId, namespaceId, apiToken };
}
exports.initKVConfig = initKVConfig;
async function saveToKV(key, data) {
    if (!kvConfig)
        return false;
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${kvConfig.accountId}/storage/kv/namespaces/${kvConfig.namespaceId}/values/${encodeURIComponent(key)}`;
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${kvConfig.apiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });
        return response.ok;
    }
    catch (error) {
        console.error('[IndexTracker] KV save error:', error);
        return false;
    }
}
async function loadFromKV(key) {
    if (!kvConfig)
        return null;
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${kvConfig.accountId}/storage/kv/namespaces/${kvConfig.namespaceId}/values/${encodeURIComponent(key)}`;
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${kvConfig.apiToken}` }
        });
        if (!response.ok)
            return null;
        return await response.json();
    }
    catch (error) {
        return null;
    }
}
/**
 * Initialize tracker - load existing queue from KV
 */
async function initIndexTracker() {
    const savedQueue = await loadFromKV(KV_INDEX_QUEUE);
    const savedStats = await loadFromKV(KV_INDEX_STATS);
    const savedHistory = await loadFromKV(KV_INDEX_HISTORY);
    if (savedQueue && Array.isArray(savedQueue)) {
        indexQueue = new Map(savedQueue.map((item) => [item.url, item]));
    }
    if (savedStats) {
        indexStats = savedStats;
    }
    if (savedHistory && Array.isArray(savedHistory)) {
        indexHistory = savedHistory;
    }
    console.log(`[IndexTracker] Initialized: ${indexQueue.size} items in queue`);
}
exports.initIndexTracker = initIndexTracker;
/**
 * Add new article to indexing queue
 * Called immediately after article generation
 */
async function trackNewArticle(url, slug, category) {
    const item = {
        url,
        slug,
        category,
        createdAt: new Date().toISOString(),
        lastCheckedAt: null,
        checkCount: 0,
        retryCount: 0,
        status: 'pending'
    };
    indexQueue.set(url, item);
    indexStats.totalTracked++;
    indexStats.pending++;
    indexStats.lastUpdated = new Date().toISOString();
    await persistQueue();
    console.log(`[IndexTracker] + Tracking: ${slug}`);
}
exports.trackNewArticle = trackNewArticle;
/**
 * Process indexing queue - called during V3 autonomous cycle
 * Returns items that were processed for activity logging
 */
async function processIndexQueue() {
    if (isProcessing) {
        return { checked: 0, indexed: 0, retried: 0, failed: 0, results: [] };
    }
    isProcessing = true;
    const results = [];
    let checked = 0, indexed = 0, retried = 0, failed = 0;
    try {
        const now = Date.now();
        const itemsToCheck = [];
        // Find items ready for checking
        for (const item of indexQueue.values()) {
            if (item.status === 'indexed' || item.status === 'failed')
                continue;
            const createdAt = new Date(item.createdAt).getTime();
            const lastChecked = item.lastCheckedAt ? new Date(item.lastCheckedAt).getTime() : 0;
            // First check: wait INDEX_CHECK_DELAY_HOURS after creation
            if (!item.lastCheckedAt && now - createdAt < INDEX_CHECK_DELAY_HOURS * 3600000) {
                continue;
            }
            // Subsequent checks: wait RETRY_INTERVAL_HOURS
            if (item.lastCheckedAt && now - lastChecked < RETRY_INTERVAL_HOURS * 3600000) {
                continue;
            }
            itemsToCheck.push(item);
            if (itemsToCheck.length >= BATCH_CHECK_SIZE)
                break;
        }
        // Process batch
        for (const item of itemsToCheck) {
            item.status = 'checking';
            item.lastCheckedAt = new Date().toISOString();
            item.checkCount++;
            try {
                const inspection = await (0, google_search_console_1.inspectUrl)(item.url);
                checked++;
                if (inspection.success && inspection.inspectionResult?.indexStatusResult) {
                    const indexStatus = inspection.inspectionResult.indexStatusResult;
                    const coverageState = indexStatus.coverageState || '';
                    if (coverageState.toLowerCase().includes('indexed') &&
                        !coverageState.toLowerCase().includes('not indexed')) {
                        // Successfully indexed!
                        item.status = 'indexed';
                        item.indexedAt = new Date().toISOString();
                        indexed++;
                        indexStats.indexed++;
                        indexStats.pending--;
                        // Calculate time to index
                        const timeToIndex = (Date.now() - new Date(item.createdAt).getTime()) / 3600000;
                        indexHistory.push({
                            url: item.url,
                            slug: item.slug,
                            indexedAt: item.indexedAt,
                            timeToIndex
                        });
                        // Update average
                        const totalTime = indexHistory.reduce((sum, h) => sum + h.timeToIndex, 0);
                        indexStats.avgTimeToIndex = totalTime / indexHistory.length;
                        results.push({
                            url: item.url,
                            slug: item.slug,
                            status: 'indexed',
                            message: `Indexed after ${timeToIndex.toFixed(1)} hours`
                        });
                    }
                    else if (coverageState.toLowerCase().includes('discovered')) {
                        // Discovered but not indexed - retry
                        if (item.retryCount < MAX_RETRY_ATTEMPTS) {
                            item.status = 'retry_scheduled';
                            item.retryCount++;
                            retried++;
                            // Request re-indexing
                            await (0, google_search_console_1.requestIndexing)(item.url);
                            results.push({
                                url: item.url,
                                slug: item.slug,
                                status: 'retry',
                                message: `Retry ${item.retryCount}/${MAX_RETRY_ATTEMPTS} - Discovered but not indexed`
                            });
                        }
                        else {
                            item.status = 'failed';
                            item.lastError = 'Max retries exceeded - still not indexed';
                            failed++;
                            indexStats.failed++;
                            indexStats.pending--;
                            results.push({
                                url: item.url,
                                slug: item.slug,
                                status: 'failed',
                                message: `Failed after ${MAX_RETRY_ATTEMPTS} retries`
                            });
                        }
                    }
                    else {
                        // Unknown state - schedule retry
                        item.status = 'retry_scheduled';
                        results.push({
                            url: item.url,
                            slug: item.slug,
                            status: 'unknown',
                            message: `Unknown state: ${coverageState}`
                        });
                    }
                }
                else {
                    // Inspection failed
                    item.status = 'retry_scheduled';
                    item.lastError = inspection.error || 'Inspection failed';
                    results.push({
                        url: item.url,
                        slug: item.slug,
                        status: 'error',
                        message: `Inspection error: ${inspection.error}`
                    });
                }
            }
            catch (error) {
                item.status = 'retry_scheduled';
                item.lastError = error.message;
                results.push({
                    url: item.url,
                    slug: item.slug,
                    status: 'error',
                    message: `Error: ${error.message}`
                });
            }
        }
        indexStats.lastUpdated = new Date().toISOString();
        await persistQueue();
    }
    finally {
        isProcessing = false;
    }
    return { checked, indexed, retried, failed, results };
}
exports.processIndexQueue = processIndexQueue;
/**
 * Get current indexing status for dashboard
 */
function getIndexStatus() {
    return {
        stats: indexStats,
        queue: Array.from(indexQueue.values()),
        recentHistory: indexHistory.slice(-50) // Last 50 indexed
    };
}
exports.getIndexStatus = getIndexStatus;
/**
 * Get pending items count (for autonomous loop decision making)
 */
function getPendingCount() {
    let count = 0;
    for (const item of indexQueue.values()) {
        if (item.status !== 'indexed' && item.status !== 'failed') {
            count++;
        }
    }
    return count;
}
exports.getPendingCount = getPendingCount;
/**
 * Force re-check a specific URL
 */
async function forceRecheck(url) {
    const item = indexQueue.get(url);
    if (!item) {
        return { success: false, message: 'URL not in tracking queue' };
    }
    item.lastCheckedAt = null; // Reset to allow immediate check
    item.status = 'pending';
    await persistQueue();
    return { success: true, message: 'Scheduled for immediate recheck' };
}
exports.forceRecheck = forceRecheck;
/**
 * Persist queue to KV
 */
async function persistQueue() {
    await Promise.all([
        saveToKV(KV_INDEX_QUEUE, Array.from(indexQueue.values())),
        saveToKV(KV_INDEX_STATS, indexStats),
        saveToKV(KV_INDEX_HISTORY, indexHistory.slice(-200)) // Keep last 200
    ]);
}
/**
 * Clear completed/failed items older than 30 days
 */
async function cleanupOldItems() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 3600000);
    let removed = 0;
    for (const [url, item] of indexQueue.entries()) {
        if ((item.status === 'indexed' || item.status === 'failed') &&
            new Date(item.createdAt).getTime() < thirtyDaysAgo) {
            indexQueue.delete(url);
            removed++;
        }
    }
    if (removed > 0) {
        await persistQueue();
    }
    return removed;
}
exports.cleanupOldItems = cleanupOldItems;
//# sourceMappingURL=indexing-tracker.js.map