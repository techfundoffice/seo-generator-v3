/**
 * SEO Data Module - Consolidated from petinsurance repo
 * Contains keywords, EEAT authors, internal linking, and utilities
 */
export interface ExpertAuthor {
    name: string;
    credentials: string;
    bio: string;
    image: string;
    expertise: string[];
}
export declare const EXPERT_AUTHORS: ExpertAuthor[];
export declare function getAuthorForTopic(title: string): ExpertAuthor;
export declare const CREDIBLE_SOURCES: {
    avma: {
        name: string;
        url: string;
        type: string;
    };
    naphia: {
        name: string;
        url: string;
        type: string;
    };
    aspca: {
        name: string;
        url: string;
        type: string;
    };
    cornell: {
        name: string;
        url: string;
        type: string;
    };
    acvim: {
        name: string;
        url: string;
        type: string;
    };
};
export declare const SEO_THRESHOLDS: {
    minTitleLength: number;
    maxTitleLength: number;
    minMetaDescLength: number;
    maxMetaDescLength: number;
    minContentWords: number;
    minKeywordDensity: number;
    maxKeywordDensity: number;
    minHeadings: number;
    minFAQs: number;
    minEntityCoverage: number;
    minScoreToSkip: number;
};
export declare function truncateTitle(title: string, maxLength?: number): string;
export declare function truncateMetaDescription(desc: string, maxLength?: number): string;
export declare function enforceSEOLimits(article: {
    title?: string;
    metaDescription?: string;
}): {
    title: string;
    metaDescription: string;
    wasModified: boolean;
};
export declare const ENTITIES: {
    base: string[];
    dog: string[];
    cat: string[];
};
export declare function registerArticleForLinking(slug: string, category: string): void;
export declare function bulkRegisterArticles(slugs: string[], category: string): number;
export declare function getInternalLinkCount(): number;
export declare function autoLink(content: string, currentSlug: string, currentCategory?: string): string;
export declare function getRelatedArticles(currentSlug: string, currentCategory?: string, limit?: number): Array<{
    slug: string;
    anchorText: string;
    category: string;
}>;
export declare function notifyIndexNow(url: string): Promise<boolean>;
export declare function getIndexNowKey(): string;
export declare const ALL_KEYWORDS: string[];
export declare function getKeywords(offset?: number, limit?: number): {
    keywords: string[];
    total: number;
    offset: number;
    limit: number;
};
export declare function getRandomKeywords(count: number): string[];
export declare function keywordToSlug(keyword: string): string;
export declare function getKeywordStats(): {
    total: number;
    categories: Record<string, number>;
};
//# sourceMappingURL=seo-data.d.ts.map