"use strict";
/**
 * SEO Data Module - Consolidated from petinsurance repo
 * Contains keywords, EEAT authors, internal linking, and utilities
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getKeywordStats = exports.keywordToSlug = exports.getRandomKeywords = exports.getKeywords = exports.ALL_KEYWORDS = exports.getIndexNowKey = exports.notifyIndexNow = exports.getRelatedArticles = exports.autoLink = exports.getInternalLinkCount = exports.bulkRegisterArticles = exports.registerArticleForLinking = exports.ENTITIES = exports.enforceSEOLimits = exports.truncateMetaDescription = exports.truncateTitle = exports.SEO_THRESHOLDS = exports.CREDIBLE_SOURCES = exports.getAuthorForTopic = exports.EXPERT_AUTHORS = void 0;
exports.EXPERT_AUTHORS = [
    {
        name: "Dr. Sarah Mitchell, DVM",
        credentials: "Doctor of Veterinary Medicine, Board Certified in Veterinary Internal Medicine",
        bio: "Dr. Mitchell has over 15 years of clinical veterinary experience and specializes in pet insurance guidance for pet owners.",
        image: "https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=150&h=150&fit=crop",
        expertise: ["internal medicine", "chronic conditions", "senior pets"]
    },
    {
        name: "Dr. James Chen, DVM, DACVIM",
        credentials: "Diplomate, American College of Veterinary Internal Medicine",
        bio: "Dr. Chen is a veterinary internist with expertise in complex medical cases and insurance coverage optimization.",
        image: "https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=150&h=150&fit=crop",
        expertise: ["oncology", "cardiology", "emergency care"]
    },
    {
        name: "Dr. Emily Rodriguez, DVM, CVA",
        credentials: "Doctor of Veterinary Medicine, Certified Veterinary Acupuncturist",
        bio: "Dr. Rodriguez combines traditional and holistic veterinary medicine, helping pet owners navigate insurance for comprehensive care.",
        image: "https://images.unsplash.com/photo-1594824476967-48c8b964273f?w=150&h=150&fit=crop",
        expertise: ["holistic care", "wellness", "preventive medicine"]
    },
    {
        name: "Michael Torres, CPCU",
        credentials: "Chartered Property Casualty Underwriter, Pet Insurance Specialist",
        bio: "Michael has 12 years in the insurance industry, specializing in pet insurance policy analysis and consumer advocacy.",
        image: "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150&h=150&fit=crop",
        expertise: ["policy comparison", "claims", "cost analysis"]
    },
    {
        name: "Dr. Amanda Foster, DVM, DACVECC",
        credentials: "Diplomate, American College of Veterinary Emergency and Critical Care",
        bio: "Dr. Foster is an emergency veterinarian who helps pet owners understand the importance of insurance for unexpected medical crises.",
        image: "https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=150&h=150&fit=crop",
        expertise: ["emergency care", "surgery", "critical care"]
    }
];
function getAuthorForTopic(title) {
    const lower = title.toLowerCase();
    if (lower.includes('emergency') || lower.includes('urgent') || lower.includes('critical')) {
        return exports.EXPERT_AUTHORS[4];
    }
    if (lower.includes('cancer') || lower.includes('oncology') || lower.includes('heart') || lower.includes('cardiac')) {
        return exports.EXPERT_AUTHORS[1];
    }
    if (lower.includes('senior') || lower.includes('chronic') || lower.includes('diabetes')) {
        return exports.EXPERT_AUTHORS[0];
    }
    if (lower.includes('cost') || lower.includes('compare') || lower.includes('claims') || lower.includes('deductible')) {
        return exports.EXPERT_AUTHORS[3];
    }
    if (lower.includes('wellness') || lower.includes('holistic') || lower.includes('preventive')) {
        return exports.EXPERT_AUTHORS[2];
    }
    const hash = title.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    return exports.EXPERT_AUTHORS[hash % exports.EXPERT_AUTHORS.length];
}
exports.getAuthorForTopic = getAuthorForTopic;
// ============================================
// CREDIBLE SOURCES FOR CITATIONS
// ============================================
exports.CREDIBLE_SOURCES = {
    avma: {
        name: "American Veterinary Medical Association (AVMA)",
        url: "https://www.avma.org",
        type: "professional organization"
    },
    naphia: {
        name: "North American Pet Health Insurance Association (NAPHIA)",
        url: "https://naphia.org",
        type: "industry association"
    },
    aspca: {
        name: "ASPCA Pet Health Insurance",
        url: "https://www.aspcapetinsurance.com",
        type: "nonprofit organization"
    },
    cornell: {
        name: "Cornell University College of Veterinary Medicine",
        url: "https://www.vet.cornell.edu",
        type: "academic institution"
    },
    acvim: {
        name: "American College of Veterinary Internal Medicine",
        url: "https://www.acvim.org",
        type: "veterinary specialty board"
    }
};
// ============================================
// SEO THRESHOLDS
// ============================================
exports.SEO_THRESHOLDS = {
    minTitleLength: 40,
    maxTitleLength: 55,
    minMetaDescLength: 120,
    maxMetaDescLength: 155,
    minContentWords: 2000,
    minKeywordDensity: 1.0,
    maxKeywordDensity: 1.5,
    minHeadings: 15,
    minFAQs: 6,
    minEntityCoverage: 0.7,
    minScoreToSkip: 90
};
// ============================================
// SEO ENFORCEMENT - Smart Truncation Utilities
// ============================================
function truncateTitle(title, maxLength = 55) {
    if (!title || title.length <= maxLength)
        return title;
    const patterns = [
        / - Complete Guide$/i, / - Ultimate Guide$/i, / Guide$/i,
        / - 2026$/i, / 2026$/i, /: 2026.*$/i,
        / - Everything You Need to Know$/i, / - What You Need to Know$/i,
        / \| .*$/i, / - .*$/i
    ];
    let truncated = title;
    for (const pattern of patterns) {
        if (truncated.length <= maxLength)
            break;
        truncated = truncated.replace(pattern, '');
    }
    if (truncated.length > maxLength) {
        const lastSpace = truncated.lastIndexOf(' ', maxLength - 3);
        truncated = truncated.substring(0, lastSpace > 20 ? lastSpace : maxLength - 3) + '...';
    }
    return truncated.trim();
}
exports.truncateTitle = truncateTitle;
function truncateMetaDescription(desc, maxLength = 155) {
    if (!desc || desc.length <= maxLength)
        return desc;
    const sentences = desc.match(/[^.!?]+[.!?]+/g) || [desc];
    let result = '';
    for (const sentence of sentences) {
        if ((result + sentence).length <= maxLength - 3) {
            result += sentence;
        }
        else {
            break;
        }
    }
    if (result.length === 0 || result.length < 80) {
        const lastSpace = desc.lastIndexOf(' ', maxLength - 3);
        result = desc.substring(0, lastSpace > 50 ? lastSpace : maxLength - 3) + '...';
    }
    return result.trim();
}
exports.truncateMetaDescription = truncateMetaDescription;
function enforceSEOLimits(article) {
    const originalTitle = article.title || '';
    const originalMeta = article.metaDescription || '';
    const title = truncateTitle(originalTitle, exports.SEO_THRESHOLDS.maxTitleLength);
    const metaDescription = truncateMetaDescription(originalMeta, exports.SEO_THRESHOLDS.maxMetaDescLength);
    const wasModified = title !== originalTitle || metaDescription !== originalMeta;
    if (wasModified) {
        if (title !== originalTitle) {
            console.log(`✂️ [SEO] Truncated title: ${originalTitle.length} → ${title.length} chars`);
        }
        if (metaDescription !== originalMeta) {
            console.log(`✂️ [SEO] Truncated meta: ${originalMeta.length} → ${metaDescription.length} chars`);
        }
    }
    return { title, metaDescription, wasModified };
}
exports.enforceSEOLimits = enforceSEOLimits;
// ============================================
// NLP ENTITIES
// ============================================
exports.ENTITIES = {
    base: [
        'deductible', 'premium', 'coverage', 'reimbursement', 'waiting period',
        'pre-existing conditions', 'annual limit', 'lifetime limit', 'wellness plan',
        'accident coverage', 'illness coverage', 'hereditary conditions', 'chronic conditions',
        'veterinarian', 'vet bills', 'emergency care', 'preventive care', 'routine care',
        'Lemonade', 'Healthy Paws', 'Trupanion', 'ASPCA', 'Nationwide', 'Embrace', 'Figo',
        'Pets Best', 'Pumpkin', 'Spot', 'MetLife', 'Progressive'
    ],
    dog: ['breed-specific', 'hip dysplasia', 'ACL injuries', 'bloat', 'cancer coverage', 'puppy', 'senior dog', 'large breed'],
    cat: ['indoor cat', 'outdoor cat', 'kitten', 'senior cat', 'feline', 'urinary issues', 'kidney disease', 'dental coverage']
};
const KEYWORD_LINKS = new Map();
let totalArticles = 0;
function slugToKeywords(slug) {
    const keywords = [];
    const base = slug.replace(/-/g, ' ').toLowerCase();
    keywords.push(base);
    const cleanBase = base
        .replace(/\s+(insurance|coverage|plans|costs|guide|review|comparison|quotes?)\s*/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (cleanBase && cleanBase !== base && cleanBase.length >= 5) {
        keywords.push(cleanBase);
    }
    const breedMatch = base.match(/^([a-z]+(?:\s+[a-z]+)?)\s+(?:cat|dog|pet|terrier|spaniel|retriever|shepherd|bulldog|poodle|hound|tree|condo|fountain|litter|feeder|tracker)/i);
    if (breedMatch && breedMatch[0].trim().length >= 5) {
        keywords.push(breedMatch[0].trim());
    }
    return [...new Set(keywords)].filter(k => k.length >= 5);
}
function registerArticleForLinking(slug, category) {
    if (!slug || !category)
        return;
    const keywords = slugToKeywords(slug);
    for (const keyword of keywords) {
        const existing = KEYWORD_LINKS.get(keyword) || [];
        if (!existing.some(d => d.slug === slug)) {
            existing.push({ slug, category });
            KEYWORD_LINKS.set(keyword, existing);
        }
    }
    totalArticles++;
}
exports.registerArticleForLinking = registerArticleForLinking;
function bulkRegisterArticles(slugs, category) {
    if (!category)
        return 0;
    let registered = 0;
    for (const slug of slugs) {
        if (slug) {
            registerArticleForLinking(slug, category);
            registered++;
        }
    }
    console.log(`🔗 [Internal Linking] Registered ${registered} articles for category "${category}" (${KEYWORD_LINKS.size} keywords, ${totalArticles} total articles)`);
    return registered;
}
exports.bulkRegisterArticles = bulkRegisterArticles;
function getInternalLinkCount() {
    return totalArticles;
}
exports.getInternalLinkCount = getInternalLinkCount;
function autoLink(content, currentSlug, currentCategory = 'petinsurance') {
    if (!content || typeof content !== 'string')
        return content;
    if (KEYWORD_LINKS.size === 0)
        return content;
    let result = content;
    let linksAdded = 0;
    const maxLinks = 5;
    const usedSlugs = new Set();
    const sortedKeywords = Array.from(KEYWORD_LINKS.keys())
        .sort((a, b) => b.length - a.length);
    for (const keyword of sortedKeywords) {
        if (linksAdded >= maxLinks)
            break;
        const candidates = KEYWORD_LINKS.get(keyword) || [];
        const sameCategoryFirst = candidates
            .filter(d => d.slug !== currentSlug && !usedSlugs.has(d.slug))
            .sort((a, b) => (a.category === currentCategory ? -1 : 1) - (b.category === currentCategory ? -1 : 1));
        if (sameCategoryFirst.length === 0)
            continue;
        const target = sameCategoryFirst[Math.floor(Math.random() * Math.min(3, sameCategoryFirst.length))];
        const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Allow matching both spaces AND hyphens for compound words like "soft-sided cat carriers"
        // Content may use hyphens (soft-sided) while keywords use spaces (soft sided)
        const flexKeyword = escapedKeyword.replace(/ /g, '[ -]');
        const regex = new RegExp(`\\b(${flexKeyword})\\b(?![^<]*>)`, 'gi');
        let matched = false;
        result = result.replace(regex, (match) => {
            if (!matched && linksAdded < maxLinks) {
                matched = true;
                linksAdded++;
                usedSlugs.add(target.slug);
                return `<a href="/${target.category}/${target.slug}" class="internal-link">${match}</a>`;
            }
            return match;
        });
    }
    return result;
}
exports.autoLink = autoLink;
function getRelatedArticles(currentSlug, currentCategory = 'petinsurance', limit = 5) {
    const related = [];
    const seenSlugs = new Set();
    const currentKeywords = slugToKeywords(currentSlug);
    for (const kw of currentKeywords) {
        if (related.length >= limit)
            break;
        const candidates = KEYWORD_LINKS.get(kw) || [];
        for (const data of candidates) {
            if (related.length >= limit)
                break;
            if (data.slug === currentSlug || seenSlugs.has(data.slug))
                continue;
            if (data.category === currentCategory) {
                seenSlugs.add(data.slug);
                related.push({
                    slug: data.slug,
                    anchorText: data.slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                    category: data.category
                });
            }
        }
    }
    if (related.length < limit) {
        for (const [_, candidates] of KEYWORD_LINKS.entries()) {
            if (related.length >= limit)
                break;
            for (const data of candidates) {
                if (related.length >= limit)
                    break;
                if (data.slug === currentSlug || seenSlugs.has(data.slug))
                    continue;
                if (data.category === currentCategory) {
                    seenSlugs.add(data.slug);
                    related.push({
                        slug: data.slug,
                        anchorText: data.slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                        category: data.category
                    });
                }
            }
        }
    }
    return related;
}
exports.getRelatedArticles = getRelatedArticles;
// ============================================
// INDEXNOW - Instant Indexing for Bing/Yandex
// ============================================
const INDEXNOW_KEY = 'catsluvus2026seo';
const INDEXNOW_HOST = 'catsluvus.com';
const indexNowQueue = [];
let indexNowProcessing = false;
let lastIndexNowPing = 0;
const INDEXNOW_MIN_INTERVAL = 5000; // 5 seconds between pings
async function notifyIndexNow(url) {
    indexNowQueue.push(url);
    if (!indexNowProcessing) {
        processIndexNowQueue();
    }
    return true;
}
exports.notifyIndexNow = notifyIndexNow;
async function processIndexNowQueue() {
    if (indexNowProcessing || indexNowQueue.length === 0)
        return;
    indexNowProcessing = true;
    while (indexNowQueue.length > 0) {
        const timeSinceLastPing = Date.now() - lastIndexNowPing;
        if (timeSinceLastPing < INDEXNOW_MIN_INTERVAL) {
            await new Promise(r => setTimeout(r, INDEXNOW_MIN_INTERVAL - timeSinceLastPing));
        }
        const urls = indexNowQueue.splice(0, Math.min(10, indexNowQueue.length));
        try {
            const response = await fetch('https://api.indexnow.org/indexnow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    host: INDEXNOW_HOST,
                    key: INDEXNOW_KEY,
                    keyLocation: `https://${INDEXNOW_HOST}/${INDEXNOW_KEY}.txt`,
                    urlList: urls
                })
            });
            lastIndexNowPing = Date.now();
            if (response.ok || response.status === 202) {
                console.log(`📡 [IndexNow] Submitted ${urls.length} URLs for indexing`);
            }
            else {
                console.log(`⚠️ [IndexNow] Response: ${response.status}`);
            }
        }
        catch (error) {
            console.log(`⚠️ [IndexNow] Error: ${error.message}`);
        }
    }
    indexNowProcessing = false;
}
function getIndexNowKey() {
    return INDEXNOW_KEY;
}
exports.getIndexNowKey = getIndexNowKey;
// ============================================
// KEYWORDS LIST (9,394 keywords)
// ============================================
// Import full keywords list from generated file
const keywords_full_1 = require("./keywords-full");
exports.ALL_KEYWORDS = keywords_full_1.ALL_KEYWORDS;
// Function to get keywords with pagination
function getKeywords(offset = 0, limit = 100) {
    const keywords = exports.ALL_KEYWORDS.slice(offset, offset + limit);
    return {
        keywords,
        total: exports.ALL_KEYWORDS.length,
        offset,
        limit
    };
}
exports.getKeywords = getKeywords;
// Function to get random keywords for batch processing
function getRandomKeywords(count) {
    const shuffled = [...exports.ALL_KEYWORDS].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
}
exports.getRandomKeywords = getRandomKeywords;
// Convert keyword to slug
function keywordToSlug(keyword) {
    return keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
exports.keywordToSlug = keywordToSlug;
// Stats
function getKeywordStats() {
    const categories = {
        cat: 0,
        dog: 0,
        exotic: 0,
        general: 0
    };
    for (const kw of exports.ALL_KEYWORDS) {
        const lower = kw.toLowerCase();
        if (lower.includes('cat') || lower.includes('kitten') || lower.includes('feline')) {
            categories.cat++;
        }
        else if (lower.includes('dog') || lower.includes('puppy') || lower.includes('canine')) {
            categories.dog++;
        }
        else if (lower.includes('bird') || lower.includes('reptile') || lower.includes('exotic') || lower.includes('rabbit')) {
            categories.exotic++;
        }
        else {
            categories.general++;
        }
    }
    return { total: exports.ALL_KEYWORDS.length, categories };
}
exports.getKeywordStats = getKeywordStats;
//# sourceMappingURL=seo-data.js.map