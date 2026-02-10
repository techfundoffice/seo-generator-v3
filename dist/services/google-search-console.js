"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRichResults = exports.inspectUrl = exports.batchNotify = exports.notifyGoogleOfNewArticle = exports.requestIndexing = exports.submitSitemap = void 0;
const googleapis_1 = require("googleapis");
const SITE_URL = 'https://catsluvus.com/';
const SITEMAP_URL = 'https://catsluvus.com/petinsurance/sitemap.xml';
let authClient = null;
let lastSitemapSubmit = 0;
const SITEMAP_THROTTLE_MS = 60000; // Only submit sitemap every 60 seconds max
// Indexing API rate limiting (Google allows ~200/day)
let indexingRequestCount = 0;
let indexingDayStart = Date.now();
const INDEXING_DAILY_LIMIT = 180; // Conservative limit below 200
const INDEXING_MIN_INTERVAL_MS = 10000; // At least 10 seconds between requests
let lastIndexingRequest = 0;
function checkIndexingRateLimit() {
    const now = Date.now();
    // Reset daily counter if new day
    if (now - indexingDayStart > 86400000) {
        indexingRequestCount = 0;
        indexingDayStart = now;
    }
    // Check daily limit
    if (indexingRequestCount >= INDEXING_DAILY_LIMIT) {
        return { allowed: false, reason: `Daily limit reached (${INDEXING_DAILY_LIMIT})` };
    }
    // Check interval
    if (now - lastIndexingRequest < INDEXING_MIN_INTERVAL_MS) {
        return { allowed: false, reason: `Too soon (wait ${Math.ceil((INDEXING_MIN_INTERVAL_MS - (now - lastIndexingRequest)) / 1000)}s)` };
    }
    return { allowed: true };
}
async function getAuthClient() {
    if (authClient)
        return authClient;
    const serviceAccountJson = process.env.GOOGLE_CLOUD_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) {
        console.log('[GSC] No service account credentials found, using ping fallback');
        return null;
    }
    try {
        const credentials = JSON.parse(serviceAccountJson);
        const auth = new googleapis_1.google.auth.GoogleAuth({
            credentials,
            scopes: [
                'https://www.googleapis.com/auth/webmasters',
                'https://www.googleapis.com/auth/webmasters.readonly',
                'https://www.googleapis.com/auth/indexing'
            ]
        });
        authClient = await auth.getClient();
        console.log(`[GSC] Authenticated as service account: ${credentials.client_email}`);
        return authClient;
    }
    catch (error) {
        console.error('[GSC] Auth error:', error.message);
        return null;
    }
}
async function submitSitemap() {
    // Throttle sitemap submissions
    const now = Date.now();
    if (now - lastSitemapSubmit < SITEMAP_THROTTLE_MS) {
        return { success: true, message: 'Sitemap submission throttled (too recent)' };
    }
    try {
        const auth = await getAuthClient();
        if (!auth) {
            return { success: false, message: 'No auth credentials available' };
        }
        const searchconsole = googleapis_1.google.searchconsole({ version: 'v1', auth });
        await searchconsole.sitemaps.submit({
            siteUrl: SITE_URL,
            feedpath: SITEMAP_URL
        });
        lastSitemapSubmit = now;
        console.log(`[GSC] ✓ Sitemap submitted: ${SITEMAP_URL}`);
        return { success: true, message: 'Sitemap submitted to Google Search Console' };
    }
    catch (error) {
        console.log(`[GSC] Sitemap submission: ${error.message}`);
        return { success: false, message: error.message };
    }
}
exports.submitSitemap = submitSitemap;
async function requestIndexing(url) {
    // Check rate limit first
    const rateCheck = checkIndexingRateLimit();
    if (!rateCheck.allowed) {
        console.log(`[GSC] Indexing rate-limited: ${rateCheck.reason}`);
        return { success: false, message: `Rate limited: ${rateCheck.reason}` };
    }
    try {
        const auth = await getAuthClient();
        if (!auth) {
            return { success: false, message: 'No auth credentials available' };
        }
        const indexing = googleapis_1.google.indexing({ version: 'v3', auth });
        await indexing.urlNotifications.publish({
            requestBody: {
                url: url,
                type: 'URL_UPDATED'
            }
        });
        // Update rate limit counters on success
        lastIndexingRequest = Date.now();
        indexingRequestCount++;
        console.log(`[GSC] ✓ Indexing requested: ${url} (${indexingRequestCount}/${INDEXING_DAILY_LIMIT} today)`);
        return { success: true, message: `Indexing requested for ${url}` };
    }
    catch (error) {
        // Indexing API requires special access, so this often fails
        console.log(`[GSC] Indexing API: ${error.message}`);
        return { success: false, message: error.message };
    }
}
exports.requestIndexing = requestIndexing;
async function notifyGoogleOfNewArticle(articleUrl) {
    // Submit sitemap (throttled)
    await submitSitemap();
    // Try indexing API (optional, often fails without special access)
    await requestIndexing(articleUrl);
}
exports.notifyGoogleOfNewArticle = notifyGoogleOfNewArticle;
// Batch submit multiple URLs (for bulk operations)
async function batchNotify(urls) {
    let success = 0;
    let failed = 0;
    // Submit sitemap once
    await submitSitemap();
    // Try indexing each URL
    for (const url of urls) {
        const result = await requestIndexing(url);
        if (result.success) {
            success++;
        }
        else {
            failed++;
        }
    }
    return { success, failed };
}
exports.batchNotify = batchNotify;
async function inspectUrl(url) {
    try {
        const auth = await getAuthClient();
        if (!auth) {
            return { success: false, error: 'No auth credentials available' };
        }
        const accessToken = await auth.getAccessToken();
        if (!accessToken || !accessToken.token) {
            return { success: false, error: 'Failed to get access token' };
        }
        // Use fetch to call the URL Inspection API directly
        // Note: API only accepts inspectionUrl and siteUrl, no inspectType parameter
        const response = await fetch('https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                inspectionUrl: url,
                siteUrl: SITE_URL
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.log(`[GSC] URL Inspection failed (${response.status}): ${errorText}`);
            return { success: false, error: `API error: ${response.status}` };
        }
        const data = await response.json();
        return {
            success: true,
            inspectionResult: data.inspectionResult
        };
    }
    catch (error) {
        console.log(`[GSC] URL Inspection error: ${error.message}`);
        return { success: false, error: error.message };
    }
}
exports.inspectUrl = inspectUrl;
// Validate rich results for an article and log results
async function validateRichResults(articleUrl) {
    const result = {
        valid: false,
        detectedTypes: [],
        warnings: [],
        errors: []
    };
    try {
        const inspection = await inspectUrl(articleUrl);
        if (!inspection.success) {
            console.log(`[Rich Results] ⚠️ Inspection unavailable: ${inspection.error}`);
            result.warnings.push(`Inspection unavailable: ${inspection.error}`);
            return result;
        }
        const richResults = inspection.inspectionResult?.richResultsResult;
        if (!richResults) {
            console.log(`[Rich Results] ⚠️ No rich results data returned`);
            result.warnings.push('No rich results data in response');
            return result;
        }
        // Log verdict
        const verdict = richResults.verdict;
        if (verdict === 'PASS') {
            console.log(`[Rich Results] ✅ Validation PASSED`);
            result.valid = true;
        }
        else if (verdict === 'PARTIAL') {
            console.log(`[Rich Results] ⚠️ Validation PARTIAL (some issues)`);
            result.valid = true;
        }
        else {
            console.log(`[Rich Results] ❌ Validation FAILED: ${verdict}`);
        }
        // Log detected items and issues
        for (const item of richResults.detectedItems || []) {
            result.detectedTypes.push(item.richResultType);
            console.log(`[Rich Results] 📋 Detected: ${item.richResultType}`);
            // Check for issues in each detected item
            for (const subItem of item.items || []) {
                for (const issue of subItem.issues || []) {
                    if (issue.severity === 'ERROR') {
                        result.errors.push(`${item.richResultType}: ${issue.issueMessage}`);
                        console.log(`[Rich Results] ❌ Error in ${item.richResultType}: ${issue.issueMessage}`);
                    }
                    else if (issue.severity === 'WARNING') {
                        result.warnings.push(`${item.richResultType}: ${issue.issueMessage}`);
                        console.log(`[Rich Results] ⚠️ Warning in ${item.richResultType}: ${issue.issueMessage}`);
                    }
                }
            }
        }
        // Summary log
        const summary = `${result.detectedTypes.length} types, ${result.errors.length} errors, ${result.warnings.length} warnings`;
        console.log(`[Rich Results] 📊 Summary: ${summary}`);
        return result;
    }
    catch (error) {
        console.log(`[Rich Results] ❌ Validation error: ${error.message}`);
        result.errors.push(error.message);
        return result;
    }
}
exports.validateRichResults = validateRichResults;
//# sourceMappingURL=google-search-console.js.map