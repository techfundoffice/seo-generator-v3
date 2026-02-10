export declare function submitSitemap(): Promise<{
    success: boolean;
    message: string;
}>;
export declare function requestIndexing(url: string): Promise<{
    success: boolean;
    message: string;
}>;
export declare function notifyGoogleOfNewArticle(articleUrl: string): Promise<void>;
export declare function batchNotify(urls: string[]): Promise<{
    success: number;
    failed: number;
}>;
export interface RichResultItem {
    richResultType: string;
    items?: Array<{
        name?: string;
        issues?: Array<{
            issueMessage: string;
            severity: 'WARNING' | 'ERROR';
        }>;
    }>;
}
export interface UrlInspectionResult {
    success: boolean;
    inspectionResult?: {
        indexStatusResult?: {
            verdict: string;
            coverageState: string;
            robotsTxtState: string;
            indexingState: string;
            lastCrawlTime?: string;
            pageFetchState: string;
            googleCanonical?: string;
            userCanonical?: string;
        };
        richResultsResult?: {
            verdict: string;
            detectedItems: RichResultItem[];
        };
    };
    error?: string;
}
export declare function inspectUrl(url: string): Promise<UrlInspectionResult>;
export declare function validateRichResults(articleUrl: string): Promise<{
    valid: boolean;
    detectedTypes: string[];
    warnings: string[];
    errors: string[];
}>;
//# sourceMappingURL=google-search-console.d.ts.map