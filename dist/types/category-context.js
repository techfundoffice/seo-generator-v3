"use strict";
/**
 * Category Context Types for SEO Generator V2
 * Enables autonomous category discovery and dynamic content generation
 * All fields populated by Copilot SDK agent during research phase
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEmptyResearchPhaseOutput = exports.createEmptyCategoryContext = void 0;
function createEmptyCategoryContext(categorySlug, domain, basePath) {
    return {
        domain,
        basePath,
        categorySlug,
        categoryName: '',
        categoryDescription: '',
        keywords: [],
        authors: [],
        credibleSources: [],
        entities: [],
        kvPrefix: `${categorySlug}:`,
        sitemapPath: `${basePath}/sitemap.xml`,
        metadata: {
            totalCPC: 0,
            avgVolume: 0,
            avgDifficulty: 0,
            affiliateRate: 0,
            revenuePotential: 0,
            marketSize: '',
            growthTrend: 'stable',
            competitionLevel: 'medium',
        },
        branding: {
            primaryColor: '#2563eb',
            secondaryColor: '#1e40af',
            tagline: '',
            footerText: '',
            menuLinks: [],
        },
        publishedKeywords: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        researchPhaseId: '',
    };
}
exports.createEmptyCategoryContext = createEmptyCategoryContext;
function createEmptyResearchPhaseOutput() {
    return {
        id: `research-${Date.now()}`,
        status: 'idle',
        startedAt: new Date().toISOString(),
        nicheDiscovery: {
            vertical: '',
            niche: '',
            reasoning: '',
            marketSize: '',
            competitorCount: 0,
            topCompetitors: [],
        },
        keywordResearch: {
            totalKeywords: 0,
            avgCPC: 0,
            avgVolume: 0,
            topKeywords: [],
            clusters: [],
        },
        competitorAnalysis: {
            gaps: [],
            opportunities: [],
            contentAngles: [],
            weaknesses: [],
        },
        monetization: {
            affiliatePrograms: [],
            adRevenueEstimate: {
                rpm: 0,
                monthlyTrafficGoal: 0,
                monthlyRevenueEstimate: 0,
            },
            revenueProjection: {
                month3: 0,
                month6: 0,
                month12: 0,
            },
        },
        targetStructure: {
            domain: '',
            basePath: '',
            slugFormat: '',
            sitemapPath: '',
            kvPrefix: '',
        },
    };
}
exports.createEmptyResearchPhaseOutput = createEmptyResearchPhaseOutput;
//# sourceMappingURL=category-context.js.map