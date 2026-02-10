/**
 * Skill Engine Service for SEO Generator V2
 * Applies skills to content generation, validation, and auditing
 */
import type { ValidationResult, AuditResult, SkillThresholds } from '../types/skills';
/**
 * Skill Engine class for applying SEO skills
 */
export declare class SkillEngine {
    private skills;
    private thresholds;
    constructor(skillNames: string[], thresholds?: Partial<SkillThresholds>);
    /**
     * Create engine from profile name
     */
    static fromProfile(profileName: string, thresholds?: Partial<SkillThresholds>): SkillEngine;
    /**
     * Get all loaded skills
     */
    getLoadedSkills(): string[];
    /**
     * Get combined best practices for prompt enhancement
     */
    getBestPracticesForPrompt(): string;
    /**
     * Validate content against skill rules
     */
    validateContent(html: string, keyword: string): ValidationResult;
    /**
     * Comprehensive audit of article content
     */
    auditContent(html: string, keyword: string): AuditResult;
    private checkContent;
    private checkTechnical;
    private checkSchema;
    private checkLinks;
    /**
     * Enhance a generation prompt with skill-based rules
     */
    enhancePrompt(basePrompt: string): string;
}
/**
 * Create a skill engine with default comprehensive profile
 */
export declare function createSkillEngine(profile?: string): SkillEngine;
/**
 * Quick validation helper
 */
export declare function quickValidate(html: string, keyword: string): ValidationResult;
/**
 * Full audit helper
 */
export declare function fullAudit(html: string, keyword: string): AuditResult;
//# sourceMappingURL=skill-engine.d.ts.map