"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.categorizeSEOIssues = exports.getOnPageScoreWithRetry = exports.getOnPageScore = void 0;
const DATAFORSEO_LOGIN = process.env.DATAFORSEO_LOGIN;
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD;
async function getOnPageScore(url) {
    if (!DATAFORSEO_LOGIN || !DATAFORSEO_PASSWORD) {
        console.warn('[DataForSEO] Missing credentials, skipping On-Page scoring');
        return null;
    }
    try {
        const credentials = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
        console.log(`[DataForSEO] Scoring: ${url}`);
        const response = await fetch('https://api.dataforseo.com/v3/on_page/instant_pages', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${credentials}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify([{
                    url: url,
                    enable_javascript: false
                }])
        });
        if (!response.ok) {
            console.warn(`[DataForSEO] HTTP error: ${response.status}`);
            return null;
        }
        const data = await response.json();
        if (!data.tasks || data.tasks.length === 0) {
            console.warn('[DataForSEO] No tasks returned');
            return null;
        }
        const taskResult = data.tasks[0];
        if (taskResult.status_code !== 20000 || !taskResult.result || taskResult.result.length === 0) {
            console.warn(`[DataForSEO] Task failed: ${taskResult.status_message}`);
            return null;
        }
        const result = taskResult.result[0];
        const items = result.items || [];
        const pageData = items[0];
        if (!pageData) {
            console.warn('[DataForSEO] No page data returned');
            return null;
        }
        const checks = pageData.checks || {};
        const meta = pageData.meta || {};
        const pageMetrics = pageData.page_metrics || {};
        let passed = 0;
        let failed = 0;
        let warnings = 0;
        const issues = [];
        for (const [checkName, checkValue] of Object.entries(checks)) {
            if (checkValue === true) {
                passed++;
            }
            else if (checkValue === false) {
                failed++;
                issues.push(checkName.replace(/_/g, ' '));
            }
            else if (typeof checkValue === 'number' && checkValue > 0) {
                warnings++;
            }
        }
        const totalChecks = passed + failed + warnings;
        const overallScore = totalChecks > 0 ? Math.round((passed / totalChecks) * 100) : 0;
        const score = {
            overallScore,
            checks: { passed, failed, warnings },
            metrics: {
                titleLength: meta.title?.length || 0,
                descriptionLength: meta.description?.length || 0,
                h1Count: meta.htags?.h1?.length || 0,
                wordCount: meta.content?.plain_text_word_count || 0,
                imagesWithAlt: pageMetrics.images_alt || 0,
                imagesWithoutAlt: pageMetrics.images_non_alt || 0,
                internalLinks: pageMetrics.links_internal || 0,
                externalLinks: pageMetrics.links_external || 0,
                loadTime: pageData.page_timing?.time_to_interactive
            },
            issues: issues.slice(0, 5),
            timestamp: new Date().toISOString()
        };
        // Log detailed check breakdown for debugging
        const failedChecks = Object.entries(checks)
            .filter(([_, v]) => v === false)
            .map(([k]) => k.replace(/_/g, ' '))
            .slice(0, 10);
        console.log(`[DataForSEO] ✅ Score: ${overallScore}/100 (${passed} passed, ${failed} failed, ${warnings} warnings)`);
        if (failedChecks.length > 0) {
            console.log(`[DataForSEO] Failed checks: ${failedChecks.join(', ')}`);
        }
        return score;
    }
    catch (error) {
        console.error(`[DataForSEO] Error: ${error.message}`);
        return null;
    }
}
exports.getOnPageScore = getOnPageScore;
async function getOnPageScoreWithRetry(url, maxRetries = 2, initialDelayMs = 10000) {
    // Wait for CDN edge caching to propagate before scoring
    if (initialDelayMs > 0) {
        console.log(`[DataForSEO] Waiting ${initialDelayMs / 1000}s for CDN propagation...`);
        await new Promise(resolve => setTimeout(resolve, initialDelayMs));
    }
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const score = await getOnPageScore(url);
        if (score)
            return score;
        if (attempt < maxRetries) {
            console.log(`[DataForSEO] Retry ${attempt}/${maxRetries} for: ${url}`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    return null;
}
exports.getOnPageScoreWithRetry = getOnPageScoreWithRetry;
function categorizeSEOIssues(issues) {
    const fixable = [];
    const informational = [];
    // Issues we can't fix (CDN/infrastructure level):
    const infrastructureIssues = [
        'no content encoding',
        'high loading time',
        'is redirect',
        'from sitemap',
        'no favicon',
        'is 4xx code',
        'is 5xx code', // Timing issue
    ];
    for (const issue of issues) {
        const isInfrastructure = infrastructureIssues.some(i => issue.toLowerCase().includes(i.toLowerCase().replace(/_/g, ' ')));
        if (isInfrastructure) {
            informational.push(issue);
        }
        else {
            fixable.push(issue);
        }
    }
    return { fixable, informational };
}
exports.categorizeSEOIssues = categorizeSEOIssues;
//# sourceMappingURL=dataforseo-client.js.map