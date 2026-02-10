/**
 * Skill Parser Service for SEO Generator V2
 * Parses skill markdown files and extracts rules, patterns, and best practices
 */
import type { ParsedSkill, SkillRule } from '../types/skills';
/**
 * Parse a skill markdown file and extract structured data
 */
export declare function parseSkillFile(skillName: string): ParsedSkill | null;
/**
 * Load multiple skills at once
 */
export declare function loadSkills(skillNames: string[]): Map<string, ParsedSkill>;
/**
 * Get combined best practices from multiple skills
 */
export declare function getCombinedBestPractices(skills: Map<string, ParsedSkill>): string[];
/**
 * Get combined rules from multiple skills
 */
export declare function getCombinedRules(skills: Map<string, ParsedSkill>): SkillRule[];
//# sourceMappingURL=skill-parser.d.ts.map