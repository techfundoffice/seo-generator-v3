"use strict";
/**
 * SEO Skills Configuration for SEO Generator V2
 * Defines skill profiles and their component skills
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDeploymentRecommendation = exports.getAllAvailableSkills = exports.getSkillsForProfile = exports.SKILL_PATHS = exports.QUALITY_GATES = exports.DEFAULT_THRESHOLDS = exports.SEO_SKILL_PROFILES = void 0;
/**
 * Skill profiles for different use cases
 */
exports.SEO_SKILL_PROFILES = {
    quick: {
        name: 'Quick',
        description: 'Essential SEO optimization for fast article generation',
        skills: ['seo-content-writer', 'seo-meta-optimizer']
    },
    comprehensive: {
        name: 'Comprehensive',
        description: 'Full SEO + marketing psychology with AI detection avoidance',
        skills: [
            'seo-audit',
            'seo-content-writer',
            'seo-meta-optimizer',
            'seo-schema-generator',
            'seo-perfect-score',
            'marketing-psychology' // Human-like writing & AI detection avoidance
        ]
    },
    advanced: {
        name: 'Advanced',
        description: 'Expert SEO + marketing with AI detection avoidance & conversion optimization',
        skills: [
            'seo-audit',
            'seo-content-writer',
            'seo-meta-optimizer',
            'seo-schema-generator',
            'seo-keyword-strategist',
            'seo-content-planner',
            'seo-structure-architect',
            'marketing-psychology',
            'marketing-ideas' // Conversion optimization
        ]
    },
    marketing: {
        name: 'Marketing',
        description: 'SEO + full marketing suite for conversion optimization',
        skills: [
            'seo-content-writer',
            'seo-meta-optimizer',
            'marketing-ideas',
            'marketing-psychology'
        ]
    },
    autonomous: {
        name: 'Autonomous Research',
        description: 'Agent-driven niche discovery, keyword research, and market analysis for autonomous category selection',
        skills: [
            'seo-keyword-strategist',
            'deep-research',
            'market-sizing-analysis',
            'apify-market-research',
            'apify-competitor-intelligence',
            'seo-cannibalization-detector',
            'seo-content-planner'
        ]
    }
};
/**
 * Default thresholds for SEO validation
 */
exports.DEFAULT_THRESHOLDS = {
    minWordCount: 2500,
    maxWordCount: 10000,
    keywordDensity: { min: 1.0, max: 2.5 },
    titleLength: { min: 30, max: 55 },
    metaDescriptionLength: { min: 120, max: 155 },
    minFAQs: 6,
    minSections: 4,
    minInternalLinks: 3,
    minExternalLinks: 2
};
/**
 * Quality gate thresholds for deployment decisions
 */
exports.QUALITY_GATES = {
    deploy: 80,
    review: 60,
    optimize: 40,
    reject: 0 // < 40: Block deployment
};
/**
 * Available skills directory paths
 */
exports.SKILL_PATHS = {
    base: '/home/runner/.claude/skills',
    seo: [
        'seo-audit',
        'seo-content-writer',
        'seo-meta-optimizer',
        'seo-schema-generator',
        'seo-keyword-strategist',
        'seo-authority-builder',
        'seo-cannibalization-detector',
        'seo-content-auditor',
        'seo-content-planner',
        'seo-content-refresher',
        'seo-snippet-hunter',
        'seo-structure-architect',
        'seo-fundamentals',
        'seo-perfect-score',
        'seo-pagespeed-analyzer',
        'seo-performance-optimizer'
    ],
    marketing: [
        'marketing-ideas',
        'marketing-psychology'
    ],
    research: [
        'deep-research',
        'market-sizing-analysis',
        'apify-market-research',
        'apify-competitor-intelligence'
    ],
    vercel: [
        'react-best-practices',
        'composition-patterns',
        'web-design-guidelines'
    ]
};
/**
 * Get skills for a profile
 */
function getSkillsForProfile(profileName) {
    const profile = exports.SEO_SKILL_PROFILES[profileName];
    return profile ? profile.skills : exports.SEO_SKILL_PROFILES.comprehensive.skills;
}
exports.getSkillsForProfile = getSkillsForProfile;
/**
 * Get all available skills
 */
function getAllAvailableSkills() {
    return [
        ...exports.SKILL_PATHS.seo,
        ...exports.SKILL_PATHS.marketing,
        ...exports.SKILL_PATHS.research,
        ...exports.SKILL_PATHS.vercel
    ];
}
exports.getAllAvailableSkills = getAllAvailableSkills;
/**
 * Get deployment recommendation based on score
 */
function getDeploymentRecommendation(score) {
    if (score >= exports.QUALITY_GATES.deploy) {
        return { action: 'deploy', message: 'Article meets quality standards. Auto-deploy enabled.' };
    }
    else if (score >= exports.QUALITY_GATES.review) {
        return { action: 'review', message: 'Article needs manual review before deployment.' };
    }
    else if (score >= exports.QUALITY_GATES.optimize) {
        return { action: 'optimize', message: 'Article needs optimization. Review suggested improvements.' };
    }
    else {
        return { action: 'reject', message: 'Article does not meet minimum quality standards.' };
    }
}
exports.getDeploymentRecommendation = getDeploymentRecommendation;
//# sourceMappingURL=seo-skills.js.map