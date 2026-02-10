export interface DataForSEOScore {
    overallScore: number;
    checks: {
        passed: number;
        failed: number;
        warnings: number;
    };
    metrics: {
        titleLength: number;
        descriptionLength: number;
        h1Count: number;
        wordCount: number;
        imagesWithAlt: number;
        imagesWithoutAlt: number;
        internalLinks: number;
        externalLinks: number;
        loadTime?: number;
    };
    issues: string[];
    timestamp: string;
}
export declare function getOnPageScore(url: string): Promise<DataForSEOScore | null>;
export declare function getOnPageScoreWithRetry(url: string, maxRetries?: number, initialDelayMs?: number): Promise<DataForSEOScore | null>;
export interface TechnicalSEOIssues {
    fixable: string[];
    informational: string[];
}
export declare function categorizeSEOIssues(issues: string[]): TechnicalSEOIssues;
//# sourceMappingURL=dataforseo-client.d.ts.map