/**
 * SEO Skills Configuration for SEO Generator V2
 * Defines skill profiles and their component skills
 */
import type { SkillProfile, SkillThresholds } from '../types/skills';
/**
 * Skill profiles for different use cases
 */
export declare const SEO_SKILL_PROFILES: Record<string, SkillProfile>;
/**
 * Default thresholds for SEO validation
 */
export declare const DEFAULT_THRESHOLDS: SkillThresholds;
/**
 * Quality gate thresholds for deployment decisions
 */
export declare const QUALITY_GATES: {
    deploy: number;
    review: number;
    optimize: number;
    reject: number;
};
/**
 * Available skills directory paths
 */
export declare const SKILL_PATHS: {
    base: string;
    seo: string[];
    marketing: string[];
    research: string[];
    vercel: string[];
};
/**
 * Get skills for a profile
 */
export declare function getSkillsForProfile(profileName: string): string[];
/**
 * Get all available skills
 */
export declare function getAllAvailableSkills(): string[];
/**
 * Get deployment recommendation based on score
 */
export declare function getDeploymentRecommendation(score: number): {
    action: 'deploy' | 'review' | 'optimize' | 'reject';
    message: string;
};
//# sourceMappingURL=seo-skills.d.ts.map