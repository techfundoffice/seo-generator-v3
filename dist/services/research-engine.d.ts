/**
 * Research Engine Service for SEO Generator V2
 * Extends SkillEngine for autonomous niche discovery and keyword research
 * Agent makes ALL strategic decisions - infrastructure only provides framework
 */
import { SkillEngine } from './skill-engine';
import type { SkillThresholds } from '../types/skills';
import type { CategoryContext, ResearchPhaseOutput, KeywordData } from '../types/category-context';
export type ResearchPhaseStatus = 'idle' | 'discovering' | 'analyzing' | 'prioritizing' | 'complete' | 'error';
export interface NicheDiscoveryInput {
    vertical?: string;
    excludeCategories?: string[];
    minCPC?: number;
    minVolume?: number;
    maxCompetition?: number;
}
export interface ResearchProgress {
    status: ResearchPhaseStatus;
    currentStep: string;
    progress: number;
    startedAt: string;
    lastUpdate: string;
    errors: string[];
}
/**
 * Research Engine for autonomous category discovery
 * Uses Copilot SDK agent to make ALL strategic decisions
 */
export declare class ResearchEngine extends SkillEngine {
    private researchOutput;
    private progress;
    constructor(thresholds?: Partial<SkillThresholds>);
    static createForResearch(thresholds?: Partial<SkillThresholds>): ResearchEngine;
    getProgress(): ResearchProgress;
    getResearchOutput(): ResearchPhaseOutput | null;
    private updateProgress;
    private addError;
    /**
     * Generate prompt for Copilot SDK to discover high-value niches
     * Agent decides which niche to target based on CPC, volume, and affiliate potential
     */
    getDiscoverNichesPrompt(input?: NicheDiscoveryInput): string;
    /**
     * Generate prompt for deep niche analysis
     * Agent analyzes the selected niche for keyword opportunities
     */
    getAnalyzeNichePrompt(niche: string, competitors?: string[]): string;
    /**
     * Generate prompt for keyword extraction with full metadata
     * Agent provides keywords with CPC, volume, difficulty, and intent
     */
    getExtractKeywordsPrompt(niche: string, clusters: any[]): string;
    /**
     * Generate prompt for revenue prioritization
     * Agent ranks keywords by (CPC × volume × affiliate potential)
     */
    getPrioritizeByRevenuePrompt(keywords: KeywordData[], affiliatePrograms: any[]): string;
    /**
     * Generate the final CategoryContext from research output
     * Transforms agent research into infrastructure-ready config
     */
    outputCategoryContext(researchOutput: ResearchPhaseOutput, domain?: string): CategoryContext;
    /**
     * Parse agent JSON response into structured data
     * Handles common parsing issues from LLM output
     */
    parseAgentResponse<T>(response: string): T | null;
    /**
     * Alias for getDiscoverNichesPrompt (V2 compatibility)
     */
    getNicheDiscoveryPrompt(options?: NicheDiscoveryInput): string;
    /**
     * Alias for getAnalyzeNichePrompt (V2 compatibility)
     */
    getNicheAnalysisPrompt(niche: string, keywordSeeds?: string[]): string;
    /**
     * Validate keyword uniqueness to prevent cannibalization
     * Returns keywords that don't overlap with existing published content
     */
    validateKeywordUniqueness(newKeywords: KeywordData[], publishedKeywords: string[]): {
        valid: KeywordData[];
        duplicates: string[];
    };
    /**
     * Get cannibalization check prompt for agent
     */
    getCannibalizationCheckPrompt(keyword: string, existingKeywords: string[]): string;
}
export declare function createResearchEngine(): ResearchEngine;
//# sourceMappingURL=research-engine.d.ts.map