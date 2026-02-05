import { Router, Request, Response } from 'express';
import * as cheerio from 'cheerio';
import { execSync } from 'child_process';
import * as path from 'path';
import { secrets } from '../services/doppler-secrets';
import { generateWithCloudflareAI, isCloudflareAIConfigured } from '../services/cloudflare-ai-client';
import { getOnPageScoreWithRetry, categorizeSEOIssues } from '../services/dataforseo-client';
import { generateArticleImages, getImageQuotaStatus, GeneratedImage } from '../services/cloudflare-image-gen';
import { SeoCheck } from 'seord';
// V3: Skill Engine Integration
import { SkillEngine, fullAudit } from '../services/skill-engine';
import { ResearchEngine, createResearchEngine, ResearchPhaseStatus } from '../services/research-engine';
import { getDeploymentRecommendation, QUALITY_GATES } from '../config/seo-skills';
import type { CategoryContext, ResearchPhaseOutput, KeywordData } from '../types/category-context';
import { createEmptyResearchPhaseOutput, createEmptyCategoryContext } from '../types/category-context';
import {
  ALL_KEYWORDS,
  getKeywords,
  getKeywordStats,
  keywordToSlug,
  getAuthorForTopic,
  autoLink,
  EXPERT_AUTHORS,
  CREDIBLE_SOURCES,
  SEO_THRESHOLDS,
  ENTITIES,
  bulkRegisterArticles,
  registerArticleForLinking,
  getRelatedArticles,
  getInternalLinkCount,
  enforceSEOLimits,
  notifyIndexNow,
  getIndexNowKey
} from '../data/seo-data';
import {
  getPrioritizedKeywords,
  getNextKeyword,
  getKeywordStats as getPriorityStats,
  getTopKeywords,
  PrioritizedKeyword
} from '../data/keyword-priorities';
import { searchAmazonProducts, AMAZON_TAG } from '../services/amazon-products';

// Lazy-load google-search-console to avoid 20+ second startup delay from googleapis
let gscModule: any = null;
async function getGSCModule() {
  if (!gscModule) {
    gscModule = await import('../services/google-search-console');
  }
  return gscModule;
}
async function notifyGoogleOfNewArticle(slug: string): Promise<{ success: boolean; message: string; sitemap?: any; indexing?: any; timestamp?: string }> {
  const gsc = await getGSCModule();
  return gsc.notifyGoogleOfNewArticle(slug);
}

async function validateArticleRichResults(articleUrl: string): Promise<{ valid: boolean; detectedTypes: string[]; warnings: string[]; errors: string[] }> {
  const gsc = await getGSCModule();
  return gsc.validateRichResults(articleUrl);
}

// Video Schema Validator for Google Rich Results
// Required properties per https://developers.google.com/search/docs/appearance/structured-data/video
function validateVideoSchema(htmlContent: string): { isValid: boolean; missingProps: string[]; foundProps: string[] } {
  const requiredProps = [
    { name: 'name', patterns: ['itemprop="name"', '"name":', '@name'] },
    { name: 'description', patterns: ['itemprop="description"', '"description":'] },
    { name: 'thumbnailUrl', patterns: ['itemprop="thumbnailUrl"', '"thumbnailUrl":'] },
    { name: 'uploadDate', patterns: ['itemprop="uploadDate"', '"uploadDate":'] },
    { name: 'duration', patterns: ['itemprop="duration"', '"duration":'] },
    { name: 'embedUrl', patterns: ['itemprop="embedUrl"', '"embedUrl":', 'youtube.com/embed'] },
    { name: 'contentUrl', patterns: ['itemprop="contentUrl"', '"contentUrl":'] }
  ];
  
  const recommendedProps = [
    { name: 'publisher', patterns: ['itemprop="publisher"', '"publisher":'] },
    { name: 'interactionStatistic', patterns: ['itemprop="interactionStatistic"', 'InteractionCounter', '"interactionStatistic":'] }
  ];
  
  const foundProps: string[] = [];
  const missingProps: string[] = [];
  
  // Check required properties
  for (const prop of requiredProps) {
    const found = prop.patterns.some(pattern => htmlContent.includes(pattern));
    if (found) {
      foundProps.push(prop.name);
    } else {
      missingProps.push(prop.name);
    }
  }
  
  // Check recommended properties (warn but don't fail)
  for (const prop of recommendedProps) {
    const found = prop.patterns.some(pattern => htmlContent.includes(pattern));
    if (found) {
      foundProps.push(prop.name + ' (recommended)');
    }
  }
  
  // Valid if all required properties are present
  const isValid = missingProps.length === 0;
  
  return { isValid, missingProps, foundProps };
}

// Enhanced SEO Score Calculator - Hybrid scoring with bonuses for our SEO improvements
async function calculateSEOScore(htmlContent: string, keyword?: string, title?: string, metaDescription?: string): Promise<{ score: number; details: { wordCount: number; keywordDensity: number; warnings: number; goodPoints: number } }> {
  try {
    const $ = cheerio.load(htmlContent);
    
    // Extract title if not provided
    const articleTitle = title || $('title').text() || $('h1').first().text() || 'Pet Insurance Guide';
    
    // Extract meta description if not provided
    const articleMetaDesc = metaDescription || $('meta[name="description"]').attr('content') || '';
    
    // Use keyword or extract from title
    const mainKeyword = keyword || articleTitle.split(' ').slice(0, 3).join(' ').toLowerCase();
    
    // Generate sub-keywords from title words
    const subKeywords = articleTitle.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3 && !['the', 'and', 'for', 'with', 'your', 'that', 'this', 'from', 'have', 'will'].includes(w))
      .slice(0, 5);
    
    // Create content JSON for seord
    const contentJson = {
      title: articleTitle,
      htmlText: htmlContent,
      keyword: mainKeyword,
      subKeywords: subKeywords.length > 0 ? subKeywords : ['pet insurance', 'coverage', 'cost'],
      metaDescription: articleMetaDesc,
      languageCode: 'en',
      countryCode: 'us'
    };
    
    // Get base score from seord library
    const seoCheck = new SeoCheck(contentJson, 'catsluvus.com');
    const result = await seoCheck.analyzeSeo();
    let baseScore = Math.round(result.seoScore || 50);
    
    // ========== ENHANCED SEO BONUSES ==========
    // Award points for our SEO improvements that seord doesn't fully credit
    let bonusPoints = 0;
    const bonusDetails: string[] = [];
    
    // 1. Schema Markup Bonus (+10 max)
    const hasArticleSchema = htmlContent.includes('"@type":"Article"') || htmlContent.includes('"@type": "Article"');
    const hasFAQSchema = htmlContent.includes('"@type":"FAQPage"') || htmlContent.includes('"@type": "FAQPage"');
    const hasBreadcrumbSchema = htmlContent.includes('"@type":"BreadcrumbList"') || htmlContent.includes('"@type": "BreadcrumbList"');
    const hasOrgSchema = htmlContent.includes('"@type":"Organization"') || htmlContent.includes('"@type": "Organization"');
    if (hasArticleSchema) { bonusPoints += 3; bonusDetails.push('Article schema'); }
    if (hasFAQSchema) { bonusPoints += 3; bonusDetails.push('FAQ schema'); }
    if (hasBreadcrumbSchema) { bonusPoints += 2; bonusDetails.push('Breadcrumb schema'); }
    if (hasOrgSchema) { bonusPoints += 2; bonusDetails.push('Organization schema'); }
    
    // 2. Internal Links Bonus (+8 max)
    const internalLinks = $('a[href*="catsluvus.com"], a[href^="/"]').length;
    if (internalLinks >= 5) { bonusPoints += 4; bonusDetails.push(`${internalLinks} internal links`); }
    else if (internalLinks >= 3) { bonusPoints += 2; }
    if (internalLinks >= 10) { bonusPoints += 4; } // Extra for 10+ links
    
    // 3. Video Schema Verification (+8 max) - Full Rich Results compliance
    const hasVideoEmbed = htmlContent.includes('youtube.com/embed');
    const hasVideoSchema = htmlContent.includes('VideoObject');
    const videoSchemaValid = validateVideoSchema(htmlContent);
    
    if (hasVideoEmbed && hasVideoSchema && videoSchemaValid.isValid) {
      bonusPoints += 8; 
      bonusDetails.push('Video embed + complete schema');
    } else if (hasVideoEmbed && hasVideoSchema) {
      bonusPoints += 5; 
      bonusDetails.push('Video embed');
      if (videoSchemaValid.missingProps.length > 0) {
        console.warn(`   [Video Schema] Missing properties for Rich Results: ${videoSchemaValid.missingProps.join(', ')}`);
      }
    } else if (hasVideoEmbed) {
      bonusPoints += 3;
      bonusDetails.push('Video (no schema)');
    }
    
    // 4. Word Count Bonus (+5 max) - for exceeding 2500 words
    const wordCount = result.wordCount || 0;
    if (wordCount >= 3500) { bonusPoints += 5; bonusDetails.push(`${wordCount} words`); }
    else if (wordCount >= 2500) { bonusPoints += 3; }
    else if (wordCount >= 1500) { bonusPoints += 1; }
    
    // 5. Heading Structure Bonus (+5 max)
    const h2Count = $('h2').length;
    const h3Count = $('h3').length;
    if (h2Count >= 5 && h3Count >= 3) { bonusPoints += 5; bonusDetails.push('Good heading structure'); }
    else if (h2Count >= 3) { bonusPoints += 3; }
    
    // 6. Images with Alt Text Bonus (+4 max)
    const imagesWithAlt = $('img[alt]').filter((_, el) => $(el).attr('alt')?.trim().length > 0).length;
    if (imagesWithAlt >= 3) { bonusPoints += 4; bonusDetails.push(`${imagesWithAlt} images with alt`); }
    else if (imagesWithAlt >= 1) { bonusPoints += 2; }
    
    // 7. Meta Description Length Bonus (+3)
    if (articleMetaDesc.length >= 120 && articleMetaDesc.length <= 160) {
      bonusPoints += 3; bonusDetails.push('Optimal meta length');
    } else if (articleMetaDesc.length >= 100 && articleMetaDesc.length <= 180) {
      bonusPoints += 1;
    }
    
    // 8. Title Length Bonus (+3)
    if (articleTitle.length >= 40 && articleTitle.length <= 60) {
      bonusPoints += 3; bonusDetails.push('Optimal title length');
    } else if (articleTitle.length >= 30 && articleTitle.length <= 70) {
      bonusPoints += 1;
    }
    
    // 9. Table/Comparison Bonus (+3)
    const hasTables = $('table').length > 0;
    if (hasTables) { bonusPoints += 3; bonusDetails.push('Comparison tables'); }
    
    // Calculate final score (cap at 100)
    const finalScore = Math.min(100, baseScore + bonusPoints);
    
    if (bonusPoints > 0) {
      console.log(`   [SEO Bonus] +${bonusPoints} points: ${bonusDetails.join(', ')}`);
    }
    
    return {
      score: finalScore,
      details: {
        wordCount: wordCount,
        keywordDensity: result.keywordDensity || 0,
        warnings: result.messages?.warnings?.length || 0,
        goodPoints: (result.messages?.goodPoints?.length || 0) + Math.floor(bonusPoints / 3)
      }
    };
  } catch (error) {
    console.error('[SEO Score] Analysis failed:', error);
    return { score: 0, details: { wordCount: 0, keywordDensity: 0, warnings: 0, goodPoints: 0 } };
  }
}

const router = Router();

// Dynamic year - automatically uses current year
const CURRENT_YEAR = new Date().getFullYear();

// ============================================================================
// Track keywords currently being processed by workers (prevents race conditions)
const keywordsInProgress: Set<string> = new Set();

// PageSpeed Result Interface (defined early for queue system)
// ============================================================================

interface PageSpeedResult {
  url: string;
  strategy: 'mobile' | 'desktop';
  scores: {
    performance: number;
    accessibility: number;
    bestPractices: number;
    seo: number;
  };
  coreWebVitals: {
    lcp: number;
    cls: number;
    tbt: number;
    fcp: number;
    si: number;
    ttfb: number;
  };
  opportunities: Array<{
    title: string;
    description: string;
    savings: string;
  }>;
  fetchedAt: string;
}

// ============================================================================
// PageSpeed Rate Limiter - Prevents 429 errors with queue and exponential backoff
// ============================================================================

interface PageSpeedQueueItem {
  url: string;
  strategy: 'mobile' | 'desktop';
  articleSlug: string;
  originalHtml: string;
  kvKey: string;
  context: CategoryContext | null;
  retryCount: number;
  addedAt: number;
}

const pageSpeedQueue: PageSpeedQueueItem[] = [];
let pageSpeedLastCall = 0;
let pageSpeedProcessing = false;
const PAGESPEED_MIN_INTERVAL = 90000; // 90 seconds between checks (was 5s)
const PAGESPEED_MAX_RETRIES = 3;
const PAGESPEED_BACKOFF_BASE = 120000; // Start with 2 minute backoff for 429s

function queuePageSpeedCheck(item: Omit<PageSpeedQueueItem, 'retryCount' | 'addedAt'>) {
  pageSpeedQueue.push({
    ...item,
    retryCount: 0,
    addedAt: Date.now()
  });
  console.log(`[PageSpeed Queue] Added: ${item.articleSlug} (queue size: ${pageSpeedQueue.length})`);
  processPageSpeedQueue();
}

async function processPageSpeedQueue() {
  if (pageSpeedProcessing || pageSpeedQueue.length === 0) return;
  
  const now = Date.now();
  const timeSinceLastCall = now - pageSpeedLastCall;
  
  if (timeSinceLastCall < PAGESPEED_MIN_INTERVAL) {
    const waitTime = PAGESPEED_MIN_INTERVAL - timeSinceLastCall;
    console.log(`[PageSpeed Queue] Rate limited, waiting ${Math.round(waitTime/1000)}s (${pageSpeedQueue.length} in queue)`);
    setTimeout(processPageSpeedQueue, waitTime + 1000);
    return;
  }
  
  pageSpeedProcessing = true;
  const item = pageSpeedQueue.shift()!;
  
  try {
    pageSpeedLastCall = Date.now();
    const pageSpeed = await analyzePageSpeedWithRetry(item.url, item.strategy, item.retryCount);
    
    console.log(`[SEO-V3] 🚀 PageSpeed: ${pageSpeed.scores.performance}/100 perf, ${pageSpeed.scores.seo}/100 seo, LCP ${pageSpeed.coreWebVitals.lcp}ms`);
    
    if (pageSpeed.scores.performance < 70) {
      console.log(`[SEO-V3] ⚠️ Performance ${pageSpeed.scores.performance}/100 - applying auto-optimizations...`);
      
      const optimizedHtml = optimizeArticleHtml(item.originalHtml);
      
      const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
      if (cfApiToken) {
        const redeployUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(item.kvKey)}`;
        await fetch(redeployUrl, {
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'text/html' },
          body: optimizedHtml
        });
        console.log(`[SEO-V3] ✨ Redeployed optimized version: ${item.kvKey}`);
        
        addActivityLog('success', `[V3] Optimized HTML deployed`, {
          url: item.url,
          originalPerformance: pageSpeed.scores.performance
        });
      }
    } else if (pageSpeed.coreWebVitals.lcp > 4000) {
      console.log(`[SEO-V3] ⚠️ LCP too slow (${pageSpeed.coreWebVitals.lcp}ms) - may hurt rankings`);
    }
    
    addActivityLog('info', `[V3] PageSpeed: ${pageSpeed.scores.performance}/100`, {
      url: item.url,
      performance: pageSpeed.scores.performance,
      seo: pageSpeed.scores.seo,
      lcp: pageSpeed.coreWebVitals.lcp
    });
    
  } catch (err: any) {
    if (err.message?.includes('429') && item.retryCount < PAGESPEED_MAX_RETRIES) {
      const backoffTime = PAGESPEED_BACKOFF_BASE * Math.pow(2, item.retryCount);
      console.log(`[PageSpeed Queue] 429 rate limited, retrying in ${Math.round(backoffTime/1000)}s (attempt ${item.retryCount + 1}/${PAGESPEED_MAX_RETRIES})`);
      
      setTimeout(() => {
        pageSpeedQueue.push({
          ...item,
          retryCount: item.retryCount + 1
        });
        processPageSpeedQueue();
      }, backoffTime);
    } else {
      console.log(`[PageSpeed Queue] Skipped: ${item.articleSlug} - ${err.message}`);
    }
  }
  
  pageSpeedProcessing = false;
  
  if (pageSpeedQueue.length > 0) {
    setTimeout(processPageSpeedQueue, PAGESPEED_MIN_INTERVAL);
  }
}

async function analyzePageSpeedWithRetry(url: string, strategy: 'mobile' | 'desktop', retryCount: number): Promise<PageSpeedResult> {
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&category=seo&category=accessibility&category=best-practices`;
  
  console.log(`[PageSpeed] Analyzing ${url} (${strategy})${retryCount > 0 ? ` [retry ${retryCount}]` : ''}...`);
  
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`PageSpeed API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  const lighthouse = data.lighthouseResult;
  
  if (!lighthouse) {
    throw new Error('No Lighthouse results in response');
  }
  
  const opportunities: PageSpeedResult['opportunities'] = [];
  const opportunityAudits = [
    'render-blocking-resources', 'unused-css-rules', 'unused-javascript',
    'modern-image-formats', 'offscreen-images', 'efficient-animated-content'
  ];
  
  for (const auditId of opportunityAudits) {
    const audit = lighthouse.audits?.[auditId];
    if (audit && audit.score !== null && audit.score < 1) {
      opportunities.push({
        title: audit.title || auditId,
        description: audit.description || '',
        savings: audit.displayValue || 'Potential savings'
      });
    }
  }
  
  return {
    url,
    strategy,
    scores: {
      performance: Math.round((lighthouse.categories?.performance?.score || 0) * 100),
      accessibility: Math.round((lighthouse.categories?.accessibility?.score || 0) * 100),
      bestPractices: Math.round((lighthouse.categories?.['best-practices']?.score || 0) * 100),
      seo: Math.round((lighthouse.categories?.seo?.score || 0) * 100)
    },
    coreWebVitals: {
      lcp: Math.round(lighthouse.audits?.['largest-contentful-paint']?.numericValue || 0),
      cls: parseFloat((lighthouse.audits?.['cumulative-layout-shift']?.numericValue || 0).toFixed(3)),
      tbt: Math.round(lighthouse.audits?.['total-blocking-time']?.numericValue || 0),
      fcp: Math.round(lighthouse.audits?.['first-contentful-paint']?.numericValue || 0),
      si: Math.round(lighthouse.audits?.['speed-index']?.numericValue || 0),
      ttfb: Math.round(lighthouse.audits?.['server-response-time']?.numericValue || 0)
    },
    opportunities,
    fetchedAt: new Date().toISOString()
  };
}

// ============================================================================
// Free PAA (People Also Ask) / Related Questions Fetcher
// Uses Google Autocomplete API (free, no API key required)
// ============================================================================

interface RelatedQuestion {
  question: string;
  source: 'autocomplete' | 'generated';
}

/**
 * Fetch real Google Autocomplete suggestions for a keyword
 * This is FREE and requires no API key
 */
async function fetchGoogleAutocomplete(keyword: string): Promise<string[]> {
  try {
    const queries = [
      keyword,
      `${keyword} cost`,
      `${keyword} worth it`,
      `${keyword} vs`,
      `how much ${keyword}`,
      `what is ${keyword}`,
      `best ${keyword}`,
      `${keyword} reviews`
    ];

    const allSuggestions: string[] = [];

    for (const query of queries.slice(0, 4)) { // Limit to 4 to be fast
      try {
        const url = `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });

        if (response.ok) {
          const data = await response.json();
          if (Array.isArray(data) && Array.isArray(data[1])) {
            allSuggestions.push(...data[1].filter((s: string) => s.includes('?') || s.length > 20));
          }
        }
      } catch (e) {
        // Silently continue on individual failures
      }
    }

    return [...new Set(allSuggestions)].slice(0, 10);
  } catch (error) {
    console.log('[PAA] Autocomplete fetch failed, using fallback');
    return [];
  }
}

/**
 * Generate PAA-style questions based on keyword patterns
 * Fallback when autocomplete doesn't return enough questions
 */
function generatePAAQuestions(keyword: string): string[] {
  const patterns = [
    `What is the average cost of ${keyword}?`,
    `Is ${keyword} worth the money?`,
    `Which company offers the best ${keyword}?`,
    `How do I choose ${keyword}?`,
    `What does ${keyword} cover?`,
    `Are there any ${keyword} that cover pre-existing conditions?`,
    `How much is ${keyword} per month?`,
    `What is not covered by ${keyword}?`,
    `When should I get ${keyword}?`,
    `Can I get ${keyword} for an older pet?`
  ];

  return patterns;
}

/**
 * Fetch real "People Also Ask" style questions for SEO optimization
 * Combines Google Autocomplete + intelligent generation
 */
async function fetchPAAQuestions(keyword: string): Promise<RelatedQuestion[]> {
  const questions: RelatedQuestion[] = [];

  // Try Google Autocomplete first (real data)
  const autocomplete = await fetchGoogleAutocomplete(keyword);
  
  // Filter for question-like suggestions
  const questionWords = ['how', 'what', 'which', 'is', 'are', 'does', 'do', 'can', 'should', 'why', 'when', 'where'];
  
  for (const suggestion of autocomplete) {
    const lower = suggestion.toLowerCase();
    if (questionWords.some(w => lower.startsWith(w)) || suggestion.includes('?')) {
      questions.push({ question: suggestion, source: 'autocomplete' });
    }
  }

  // Add generated questions if we don't have enough
  if (questions.length < 8) {
    const generated = generatePAAQuestions(keyword);
    for (const q of generated) {
      if (questions.length >= 8) break;
      if (!questions.some(existing => existing.question.toLowerCase() === q.toLowerCase())) {
        questions.push({ question: q, source: 'generated' });
      }
    }
  }

  console.log(`[PAA] Found ${questions.filter(q => q.source === 'autocomplete').length} real questions, ${questions.filter(q => q.source === 'generated').length} generated`);
  return questions.slice(0, 8);
}

// ============================================================================
// GitHub Copilot SDK Integration (True SDK, not CLI wrapper)
// Uses CopilotClient -> createSession() -> sendAndWait()
// ============================================================================

let CopilotClientClass: any = null;
let defineTool: any = null;
let sdkLoaded = false;
let sdkError: string | null = null;

// ============================================================================
// YouTube Video Search for SEO Articles
// Uses Python youtube_search library to find relevant videos
// ============================================================================

interface YouTubeVideo {
  videoId: string;
  title: string;
  description: string;
  duration: string;
  durationISO: string;
  channel: string;
  views: string;
  viewCount: number;
  published: string;
  publishedISO: string;
  thumbnailUrl: string;
  embedUrl: string;
  watchUrl: string;
}

interface YouTubeSearchResult {
  success: boolean;
  keyword?: string;
  count?: number;
  videos?: YouTubeVideo[];
  error?: string;
}

/**
 * Search YouTube for relevant videos
 * Calls Python script that uses youtube_search library (no API key needed)
 */
function searchYouTubeVideo(keyword: string): YouTubeSearchResult {
  try {
    const scriptPath = path.resolve(process.cwd(), 'src/services/youtube-search.py');
    const result = execSync(`python3 "${scriptPath}" "${keyword}"`, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024
    });
    return JSON.parse(result.trim());
  } catch (error: any) {
    console.log(`⚠️ [YouTube] Search failed for "${keyword}":`, error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// V3 Video Search Funnel - 5-Level Relevance-Based Video Discovery
// See .github/skills/video-search-funnel/SKILL.md for full specification
// ============================================================================

const CATEGORY_SEARCH_TERMS: Record<string, string[]> = {
  'cat-food-delivery-services': ['best cat food brands review', 'cat food review', 'healthy cat food guide'],
  'cat-trees-furniture': ['cat tree review', `best cat trees ${CURRENT_YEAR}`, 'cat furniture tour'],
  'cat-dna-testing': ['cat DNA test results', 'cat breed test review', 'cat genetics explained'],
  'cat-grooming': ['cat grooming tutorial', 'how to groom cat at home', 'cat brushing tips'],
  'cat-litter-boxes': ['best cat litter box review', 'self cleaning litter box', 'cat litter comparison'],
  'cat-health': ['cat health tips vet', 'cat wellness check', 'healthy cat signs'],
  'cat-nutrition': ['cat nutrition guide', 'what to feed your cat', 'cat diet tips'],
  'cat-toys': ['best cat toys review', 'interactive cat toys', 'cat toy comparison'],
  'cat-beds': ['best cat beds review', 'cozy cat bed tour', 'cat sleeping spots'],
  'cat-carriers': ['cat carrier review', 'best cat carrier travel', 'cat travel tips'],
  'cat-trees-condos': ['cat condo review', `best cat condos ${CURRENT_YEAR}`, 'cat climbing tower'],
};

const FUNNY_CAT_CONTEXT_ACTIONS: Record<string, string[]> = {
  'cat-food-delivery-services': ['eating', 'food reaction', 'treats', 'hungry cat'],
  'cat-nutrition': ['eating', 'food', 'mealtime', 'treats reaction'],
  'cat-trees-furniture': ['climbing', 'jumping', 'falling off tree', 'tower fails'],
  'cat-trees-condos': ['climbing fails', 'jumping', 'cat tower', 'climbing'],
  'cat-beds': ['sleeping', 'napping', 'cozy', 'bed fails'],
  'cat-grooming': ['bath time', 'grooming fails', 'brushing reaction', 'spa day'],
  'cat-litter-boxes': ['bathroom', 'litter box', 'digging'],
  'cat-dna-testing': ['breed reveal', 'personality', 'smart cat'],
  'cat-health': ['vet visit', 'medicine time', 'check up'],
  'DEFAULT': [`compilation ${CURRENT_YEAR}`, 'fails', 'cute moments', 'being weird'],
};

// ============================================================================
// V3 CATEGORY-SPECIFIC CONTENT DATA
// Dynamic authors, brands, images, FAQs, and external links per category
// Prevents hardcoded DNA testing content from appearing in litter box articles
// ============================================================================

interface CategoryContentData {
  author: { name: string; title: string; credentials: string; bio: string };
  brands: string[];
  comparisonHeaders: string[];
  comparisonRows: string[][];
  imageAltTemplates: string[];
  imageCaptions: string[];
  faqTemplates: { question: string; answerHint: string }[];
  externalLinks: { url: string; text: string; context: string }[];
}

const CATEGORY_CONTENT_DATA: Record<string, CategoryContentData> = {
  'cat-automatic-litter-box-cleaners': {
    author: { 
      name: 'Dr. Jennifer Adams', 
      title: 'Pet Product Reviewer', 
      credentials: 'DVM, 12+ years reviewing cat products',
      bio: 'Veterinarian and expert product reviewer specializing in cat hygiene and automated pet products.'
    },
    brands: ['Litter-Robot 4', 'PetSafe ScoopFree', 'Whisker Litter-Robot', 'CatGenie', 'PetKit Pura Max'],
    comparisonHeaders: ['Product', 'Price', 'Noise Level', 'Capacity', 'Smart Features'],
    comparisonRows: [
      ['Litter-Robot 4', '$699', '< 40 dB', '8+ lbs cats', 'WiFi, App, Health Tracking'],
      ['PetSafe ScoopFree', '$189', '< 45 dB', '15 lbs cats', 'Crystal Trays, Odor Control'],
      ['CatGenie', '$549', '< 50 dB', '6+ lbs cats', 'Self-Washing, Flushable'],
      ['PetKit Pura Max', '$449', '< 38 dB', '18 lbs cats', 'App Control, Deodorizer'],
      ['Whisker Litter-Robot 3', '$499', '< 42 dB', '7+ lbs cats', 'WiFi, Night Light']
    ],
    imageAltTemplates: ['automatic litter box {keyword}', 'self-cleaning litter box {keyword}', 'cat using automatic litter box'],
    imageCaptions: ['Modern automatic litter box for hassle-free cleaning.', 'Self-cleaning technology keeps your home fresh.', 'Smart litter box with app connectivity.'],
    faqTemplates: [
      { question: 'What is {keyword}?', answerHint: 'Definition and how it works' },
      { question: 'How much does {keyword} cost?', answerHint: 'Price ranges $189-$699' },
      { question: 'Is {keyword} worth the investment?', answerHint: 'Time savings vs cost analysis' },
      { question: 'How loud is {keyword}?', answerHint: 'Decibel levels 38-50 dB' },
      { question: 'What size cats can use {keyword}?', answerHint: 'Weight limits by model' },
      { question: 'How often should I clean {keyword}?', answerHint: 'Maintenance schedule' },
      { question: 'Do cats like {keyword}?', answerHint: 'Transition tips and acceptance rates' },
      { question: 'What litter works best with {keyword}?', answerHint: 'Clumping vs crystal litter compatibility' }
    ],
    externalLinks: [
      { url: 'https://www.litter-robot.com', text: 'Litter-Robot Official', context: 'Link in comparison section' },
      { url: 'https://www.petsafe.net', text: 'PetSafe Official', context: 'Link in comparison section' },
      { url: 'https://www.petkit.com', text: 'PetKit Official', context: 'Link in comparison section' }
    ]
  },
  'cat-trees-furniture': {
    author: { 
      name: 'Sarah Thompson', 
      title: 'Cat Behavior Specialist', 
      credentials: 'CCBC, 15+ years in feline enrichment',
      bio: 'Certified cat behavior consultant specializing in feline environmental enrichment and cat furniture design.'
    },
    brands: ['Frisco', 'Feandrea', 'Go Pet Club', 'Armarkat', 'TRIXIE'],
    comparisonHeaders: ['Brand', 'Price Range', 'Height', 'Weight Capacity', 'Key Features'],
    comparisonRows: [
      ['Frisco', '$50-200', '48-72"', '40+ lbs', 'Sisal Posts, Condos, Platforms'],
      ['Feandrea', '$60-180', '54-67"', '35+ lbs', 'Multi-Level, Hammocks, Caves'],
      ['Go Pet Club', '$80-250', '50-77"', '45+ lbs', 'Ladders, Baskets, Scratching Posts'],
      ['Armarkat', '$40-160', '50-78"', '30+ lbs', 'Fleece Covering, Perches'],
      ['TRIXIE', '$100-300', '48-65"', '50+ lbs', 'Scratching Surfaces, Toys']
    ],
    imageAltTemplates: ['cat tree {keyword}', 'cat furniture {keyword}', 'cat climbing tower {keyword}'],
    imageCaptions: ['Multi-level cat tree for active cats.', 'Premium cat furniture with scratching posts.', 'Cozy cat condo for rest and play.'],
    faqTemplates: [
      { question: 'What is {keyword}?', answerHint: 'Definition and benefits' },
      { question: 'How much does {keyword} cost?', answerHint: 'Price ranges $40-$300' },
      { question: 'What height {keyword} is best?', answerHint: 'Based on cat size and room space' },
      { question: 'How to choose {keyword} for multiple cats?', answerHint: 'Platforms and weight capacity' },
      { question: 'How to assemble {keyword}?', answerHint: 'Tools and time needed' },
      { question: 'How durable is {keyword}?', answerHint: 'Materials and lifespan' },
      { question: 'Can {keyword} tip over?', answerHint: 'Stability and anchoring tips' },
      { question: 'What features matter most in {keyword}?', answerHint: 'Scratching posts, perches, condos' }
    ],
    externalLinks: [
      { url: 'https://www.chewy.com/b/cat-trees-condos-scratchers-312', text: 'Chewy Cat Trees', context: 'Link in comparison section' },
      { url: 'https://www.amazon.com/cat-trees', text: 'Amazon Cat Trees', context: 'Link in comparison section' },
      { url: 'https://www.petco.com/shop/en/petcostore/category/cat/cat-furniture', text: 'Petco Cat Furniture', context: 'Link in comparison section' }
    ]
  },
  'cat-dna-testing': {
    author: { 
      name: 'Dr. Sarah Mitchell', 
      title: 'Feline Geneticist', 
      credentials: 'PhD in Animal Genetics',
      bio: 'Expert in feline genetics and cat DNA testing with over 10 years of research experience.'
    },
    brands: ['Basepaws', 'Wisdom Panel', 'Orivet', 'MyCatDNA', 'Optimal Selection'],
    comparisonHeaders: ['Provider', 'Price', 'Breeds Tested', 'Health Markers', 'Turnaround'],
    comparisonRows: [
      ['Basepaws', '$129-299', '21+ breeds', '40+ markers', '4-6 weeks'],
      ['Wisdom Panel', '$99-159', '70+ breeds', '25+ markers', '2-3 weeks'],
      ['Orivet', '$95-145', '18+ breeds', '200+ markers', '2-3 weeks'],
      ['MyCatDNA', '$89', '22+ breeds', '40+ markers', '3-4 weeks'],
      ['Optimal Selection', '$99', '28 breeds', '40+ markers', '2-3 weeks']
    ],
    imageAltTemplates: ['cat DNA testing {keyword}', 'feline genetics {keyword}', 'cat breed test {keyword}'],
    imageCaptions: ['Understanding your cat\'s genetic makeup.', 'DNA testing reveals breed and health insights.', 'Discover your cat\'s unique genetic story.'],
    faqTemplates: [
      { question: 'What is {keyword}?', answerHint: 'Definition and how DNA tests work' },
      { question: 'How much does {keyword} cost?', answerHint: 'Price ranges $89-$299' },
      { question: 'How accurate is {keyword}?', answerHint: 'Accuracy stats 95%+' },
      { question: 'Which is best for {keyword}?', answerHint: 'Top recommendation' },
      { question: 'How long do {keyword} results take?', answerHint: 'Turnaround 2-6 weeks' },
      { question: 'Is {keyword} worth it?', answerHint: 'Value analysis' },
      { question: 'What breeds can be detected?', answerHint: 'Number of breeds detected' },
      { question: 'Are there health insights?', answerHint: 'Health markers overview' }
    ],
    externalLinks: [
      { url: 'https://basepaws.com', text: 'Basepaws Cat DNA Test', context: 'Link in comparison section' },
      { url: 'https://www.wisdompanel.com', text: 'Wisdom Panel', context: 'Link in comparison section' }
    ]
  },
  'cat-food-delivery-services': {
    author: { 
      name: 'Dr. Amanda Chen', 
      title: 'Veterinary Nutritionist', 
      credentials: 'DVM, Diplomate ACVN',
      bio: 'Board-certified veterinary nutritionist specializing in feline dietary needs and premium cat food.'
    },
    brands: ['Smalls', 'The Farmer\'s Dog', 'Nom Nom', 'Ollie', 'Open Farm'],
    comparisonHeaders: ['Brand', 'Price/Day', 'Food Type', 'Delivery Frequency', 'Key Features'],
    comparisonRows: [
      ['Smalls', '$2-4/day', 'Fresh/Freeze-Dried', 'Bi-weekly', 'Human-Grade, Cat-Specific'],
      ['Nom Nom', '$3-6/day', 'Fresh Cooked', 'Weekly', 'Vet-Formulated, Portioned'],
      ['Ollie', '$2-5/day', 'Fresh Cooked', 'Bi-weekly', 'Human-Grade, Custom Recipes'],
      ['The Farmer\'s Dog', '$2-6/day', 'Fresh Cooked', 'Bi-weekly', 'Human-Grade, USDA Certified'],
      ['Open Farm', '$1-3/day', 'Dry/Wet', 'Monthly', 'Ethically Sourced, Sustainable']
    ],
    imageAltTemplates: ['cat food delivery {keyword}', 'fresh cat food {keyword}', 'premium cat food subscription {keyword}'],
    imageCaptions: ['Fresh cat food delivered to your door.', 'Premium cat nutrition made easy.', 'Healthy meals for your feline friend.'],
    faqTemplates: [
      { question: 'What is {keyword}?', answerHint: 'Definition and how it works' },
      { question: 'How much does {keyword} cost?', answerHint: 'Price ranges $1-$6/day' },
      { question: 'Is {keyword} worth it?', answerHint: 'Quality vs convenience analysis' },
      { question: 'How often is {keyword} delivered?', answerHint: 'Delivery schedules' },
      { question: 'Is {keyword} healthy for cats?', answerHint: 'Nutritional benefits' },
      { question: 'Can I customize {keyword}?', answerHint: 'Customization options' },
      { question: 'How long does {keyword} stay fresh?', answerHint: 'Storage and shelf life' },
      { question: 'Which {keyword} is best for picky eaters?', answerHint: 'Taste preferences' }
    ],
    externalLinks: [
      { url: 'https://www.smalls.com', text: 'Smalls Cat Food', context: 'Link in comparison section' },
      { url: 'https://www.nomnomnow.com', text: 'Nom Nom Fresh Pet Food', context: 'Link in comparison section' }
    ]
  },
  'DEFAULT': {
    author: { 
      name: 'Lisa Park', 
      title: 'Cat Care Expert', 
      credentials: 'CPDT-KA, 10+ years in pet care',
      bio: 'Professional cat care specialist with expertise in feline wellness and product recommendations.'
    },
    brands: ['Top Brand 1', 'Top Brand 2', 'Top Brand 3', 'Top Brand 4', 'Top Brand 5'],
    comparisonHeaders: ['Brand', 'Price', 'Features', 'Quality', 'Rating'],
    comparisonRows: [
      ['Top Brand 1', '$50-100', 'Premium Features', 'High', '4.8/5'],
      ['Top Brand 2', '$40-80', 'Standard Features', 'Good', '4.5/5'],
      ['Top Brand 3', '$60-120', 'Advanced Features', 'High', '4.7/5'],
      ['Top Brand 4', '$30-60', 'Basic Features', 'Standard', '4.2/5'],
      ['Top Brand 5', '$70-150', 'Pro Features', 'Premium', '4.9/5']
    ],
    imageAltTemplates: ['cat product {keyword}', 'cat care {keyword}', 'cat supplies {keyword}'],
    imageCaptions: ['Quality cat products for your feline.', 'Expert-recommended cat supplies.', 'The best in cat care.'],
    faqTemplates: [
      { question: 'What is {keyword}?', answerHint: 'Definition and overview' },
      { question: 'How much does {keyword} cost?', answerHint: 'Price range overview' },
      { question: 'Is {keyword} worth it?', answerHint: 'Value analysis' },
      { question: 'What are the best options for {keyword}?', answerHint: 'Top recommendations' },
      { question: 'How to choose {keyword}?', answerHint: 'Selection criteria' },
      { question: 'Where to buy {keyword}?', answerHint: 'Purchase options' },
      { question: 'How does {keyword} compare?', answerHint: 'Comparison overview' },
      { question: 'What should I know about {keyword}?', answerHint: 'Key considerations' }
    ],
    externalLinks: [
      { url: 'https://www.chewy.com', text: 'Chewy', context: 'Link in comparison section' },
      { url: 'https://www.petco.com', text: 'Petco', context: 'Link in comparison section' }
    ]
  }
};

function getCategoryContentData(categorySlug: string): CategoryContentData {
  const normalizedSlug = categorySlug.toLowerCase()
    .replace(/&amp;/g, '')
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .replace(/-+/g, '-');
  
  return CATEGORY_CONTENT_DATA[normalizedSlug] || CATEGORY_CONTENT_DATA['DEFAULT'];
}

/**
 * Fetch real Amazon products for a keyword and format for comparison table
 * Returns formatted data for AI prompt and product schema
 */
interface AmazonProductData {
  products: Array<{
    name: string;
    price: string;
    priceValue: number;
    asin: string;
    url: string;
    rating: string;
    features: string;
    amazonSearch: string;
  }>;
  comparisonRows: string[][];
  productSchemaItems: object[];
  promptText: string;
}

async function fetchAmazonProductsForKeyword(keyword: string, category: string = 'All'): Promise<AmazonProductData> {
  const emptyResult: AmazonProductData = {
    products: [],
    comparisonRows: [],
    productSchemaItems: [],
    promptText: ''
  };

  try {
    console.log(`[Amazon] Fetching products for: "${keyword}"`);
    const result = await searchAmazonProducts(keyword, category, 5);

    if (!result.products || result.products.length === 0) {
      console.log(`[Amazon] No products found for: "${keyword}"`);
      return emptyResult;
    }

    console.log(`[Amazon] Found ${result.products.length} products`);

    const products = result.products.map(p => ({
      name: p.title.length > 60 ? p.title.substring(0, 57) + '...' : p.title,
      price: p.price,
      priceValue: p.priceValue,
      asin: p.asin,
      url: p.detailPageUrl,
      rating: p.rating ? `${p.rating}/5` : '4.5/5',
      features: p.features?.slice(0, 2).join('; ') || 'Premium quality',
      amazonSearch: p.title.replace(/[^a-zA-Z0-9\s]/g, '').split(' ').slice(0, 5).join('+')
    }));

    // Format for comparison table rows
    const comparisonRows = products.map(p => [
      p.name,
      p.price,
      p.features,
      p.rating,
      p.amazonSearch
    ]);

    // Format for product schema with real Amazon URLs
    const productSchemaItems = products.map((p, index) => ({
      "@type": "ListItem",
      "position": index + 1,
      "item": {
        "@type": "Product",
        "name": p.name,
        "description": `${p.name} - ${p.features}`,
        "sku": p.asin,
        "offers": {
          "@type": "Offer",
          "price": p.priceValue.toString(),
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock",
          "url": p.url
        },
        "aggregateRating": p.rating ? {
          "@type": "AggregateRating",
          "ratingValue": p.rating.replace('/5', ''),
          "bestRating": "5"
        } : undefined
      }
    }));

    // Format for AI prompt
    const promptText = `
REAL AMAZON PRODUCTS (USE THESE EXACT PRODUCTS IN YOUR COMPARISON TABLE):
${products.map((p, i) => `${i + 1}. "${p.name}" - ${p.price} - ASIN: ${p.asin}
   Features: ${p.features}
   Rating: ${p.rating}
   Amazon URL: ${p.url}`).join('\n')}

IMPORTANT: Use these EXACT product names and prices in your comparisonTable. Do NOT make up products.
`;

    return {
      products,
      comparisonRows,
      productSchemaItems,
      promptText
    };
  } catch (error: any) {
    console.error(`[Amazon] Error fetching products: ${error.message}`);
    return emptyResult;
  }
}

/**
 * Get category-specific product guidance for the AI
 * This helps the AI understand what types of real products exist for each category
 * WITHOUT hardcoding specific products - the AI uses its training knowledge
 */
function getCategoryProductExamples(categorySlug: string, keyword: string): string {
  const categoryGuidance: Record<string, string> = {
    'cat-carriers-travel-products': `
For CAT CARRIERS, popular brands include: Sherpa, Petmate, Sleepypod, Catit, Bergan, AmazonBasics, Necoichi, Mr. Peanut's.
Example product format: "Sherpa Original Deluxe Pet Carrier - Medium" with price ~$40-60
Consider: airline-approved carriers, soft-sided vs hard-sided, backpack carriers, expandable carriers.`,

    'cat-calming-anxiety-products': `
For CAT CALMING PRODUCTS, popular brands include: Feliway, Comfort Zone, ThunderEase, Pet Naturals, VetriScience, Zesty Paws, NaturVet.
Example product format: "Feliway Classic Calming Diffuser Starter Kit" with price ~$25-40
Consider: pheromone diffusers, calming collars, treats/chews, sprays, supplements.`,

    'cat-litter-boxes': `
For CAT LITTER BOXES, popular brands include: Litter-Robot, PetSafe, Nature's Miracle, Catit, Van Ness, Petmate, IRIS USA, Modkat.
Example product format: "IRIS USA Top Entry Cat Litter Box" with price ~$25-45
Consider: covered/hooded, top-entry, self-cleaning/automatic, high-sided, corner designs.`,

    'cat-automatic-litter-box-cleaners': `
For AUTOMATIC LITTER BOXES, popular brands include: Litter-Robot, PetSafe ScoopFree, CatGenie, PetKit, Whisker, Casa Leo.
Example product format: "Litter-Robot 4 Automatic Self-Cleaning Litter Box" with price ~$500-700
Consider: WiFi-enabled, health tracking, multiple cat capacity, noise level, maintenance.`,

    'cat-trees-furniture': `
For CAT TREES & FURNITURE, popular brands include: Frisco, Feandrea, Go Pet Club, Armarkat, TRIXIE, Yaheetech, Hey-brother.
Example product format: "Frisco 72-Inch Cat Tree with Hammock" with price ~$80-150
Consider: height, weight capacity, scratching posts, condos, platforms, hammocks.`,

    'cat-dna-testing': `
For CAT DNA TESTS, popular brands include: Basepaws, Wisdom Panel, Orivet, MyCatDNA, Optimal Selection.
Example product format: "Basepaws Cat DNA Test Kit - Breed + Health" with price ~$129-199
Consider: breeds detected, health markers, turnaround time, accuracy.`,

    'cat-food-delivery-services': `
For CAT FOOD DELIVERY, popular brands include: Smalls, Nom Nom, Ollie, The Farmer's Dog, Open Farm, Tiki Cat, Weruva.
Example product format: "Smalls Fresh Cat Food Subscription - Chicken Recipe" with price ~$2-5/day
Consider: fresh vs freeze-dried, subscription frequency, customization, ingredients.`,

    'DEFAULT': `
For "${keyword}", think of the TOP 5 most popular products sold on Amazon for this category.
Use your knowledge of real brands and products that cat owners actually buy.
Include a mix of premium and budget-friendly options with realistic prices.`
  };

  const slug = categorySlug.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return categoryGuidance[slug] || categoryGuidance['DEFAULT'];
}

const NEGATIVE_VIDEO_KEYWORDS = ['insurance', 'sad', 'death', 'died', 'rip', 'abuse', 'rescue abandoned', 'injured', 'scary', 'horror', 'attack', 'fight'];

interface VideoFunnelResult {
  video: YouTubeVideo | undefined;
  level: number;
  searchQuery: string;
  fallbackUsed: boolean;
}

function parseDurationToSeconds(duration: string): number {
  if (!duration) return 0;
  const parts = duration.split(':').reverse();
  let seconds = 0;
  if (parts[0]) seconds += parseInt(parts[0], 10) || 0;
  if (parts[1]) seconds += (parseInt(parts[1], 10) || 0) * 60;
  if (parts[2]) seconds += (parseInt(parts[2], 10) || 0) * 3600;
  return seconds;
}

const DOG_ONLY_REGEX = /\bdog(s)?\b/i;
const CAT_REGEX = /\bcat(s)?\b/i;

function isVideoRelevant(video: YouTubeVideo, category: string): boolean {
  const title = video.title.toLowerCase();
  
  if (category !== 'petinsurance' && (title.includes('insurance') || title.includes('pet insurance'))) {
    return false;
  }
  
  if (DOG_ONLY_REGEX.test(title) && !CAT_REGEX.test(title)) {
    return false;
  }
  
  for (const negWord of NEGATIVE_VIDEO_KEYWORDS) {
    if (category !== 'petinsurance' && negWord === 'insurance') continue;
    if (title.includes(negWord)) {
      return false;
    }
  }
  
  if (video.viewCount && video.viewCount < 500) {
    return false;
  }
  
  const durationSecs = parseDurationToSeconds(video.duration);
  if (durationSecs > 0 && durationSecs < 30) {
    return false;
  }
  
  return true;
}

function isFunnyVideoValid(video: YouTubeVideo): boolean {
  const title = video.title.toLowerCase();
  
  if (title.includes('insurance') || title.includes('pet insurance')) {
    return false;
  }
  
  if (DOG_ONLY_REGEX.test(title) && !CAT_REGEX.test(title)) {
    return false;
  }
  
  for (const negWord of NEGATIVE_VIDEO_KEYWORDS) {
    if (negWord === 'insurance') continue;
    if (title.includes(negWord)) {
      return false;
    }
  }
  
  if (video.viewCount && video.viewCount < 500) {
    return false;
  }
  
  const durationSecs = parseDurationToSeconds(video.duration);
  if (durationSecs > 0 && durationSecs < 30) {
    return false;
  }
  
  return true;
}

function searchVideoFunnel(keyword: string, category: string): VideoFunnelResult {
  const categorySlug = category.toLowerCase().replace(/\s+/g, '-');
  
  const level1Query = keyword;
  console.log(`[Video Funnel] L1: "${level1Query}"`);
  let result = searchYouTubeVideo(level1Query);
  if (result.success && result.videos?.length) {
    const relevant = result.videos.find(v => isVideoRelevant(v, categorySlug));
    if (relevant) {
      return { video: relevant, level: 1, searchQuery: level1Query, fallbackUsed: false };
    }
  }
  
  const categoryTerms = categorySlug.replace(/-/g, ' ');
  const level2Query = `${categoryTerms} ${keyword} review`;
  console.log(`[Video Funnel] L2: "${level2Query}"`);
  result = searchYouTubeVideo(level2Query);
  if (result.success && result.videos?.length) {
    const relevant = result.videos.find(v => isVideoRelevant(v, categorySlug));
    if (relevant) {
      return { video: relevant, level: 2, searchQuery: level2Query, fallbackUsed: false };
    }
  }
  
  const categorySearchTerms = CATEGORY_SEARCH_TERMS[categorySlug] || CATEGORY_SEARCH_TERMS['cat-health'] || [`cat care tips ${CURRENT_YEAR}`];
  const level3Query = categorySearchTerms[0];
  console.log(`[Video Funnel] L3: "${level3Query}"`);
  result = searchYouTubeVideo(level3Query);
  if (result.success && result.videos?.length) {
    const relevant = result.videos.find(v => isVideoRelevant(v, categorySlug));
    if (relevant) {
      return { video: relevant, level: 3, searchQuery: level3Query, fallbackUsed: false };
    }
  }
  
  let broadTopic = 'cat care';
  if (categorySlug.includes('food') || categorySlug.includes('nutrition')) broadTopic = 'cat feeding guide';
  else if (categorySlug.includes('tree') || categorySlug.includes('furniture') || categorySlug.includes('condo')) broadTopic = 'cat furniture';
  else if (categorySlug.includes('dna') || categorySlug.includes('breed')) broadTopic = 'cat breeds explained';
  else if (categorySlug.includes('health')) broadTopic = 'cat wellness tips';
  else if (categorySlug.includes('groom')) broadTopic = 'cat grooming';
  
  const level4Query = `${broadTopic} guide ${CURRENT_YEAR}`;
  console.log(`[Video Funnel] L4: "${level4Query}"`);
  result = searchYouTubeVideo(level4Query);
  if (result.success && result.videos?.length) {
    const relevant = result.videos.find(v => isVideoRelevant(v, categorySlug));
    if (relevant) {
      return { video: relevant, level: 4, searchQuery: level4Query, fallbackUsed: false };
    }
  }
  
  const contextActions = FUNNY_CAT_CONTEXT_ACTIONS[categorySlug] || FUNNY_CAT_CONTEXT_ACTIONS['DEFAULT'];
  const funnyAction = contextActions[Math.floor(Math.random() * contextActions.length)];
  const level5Query = `funny cat ${funnyAction}`;
  console.log(`[Video Funnel] L5 (funny fallback): "${level5Query}"`);
  result = searchYouTubeVideo(level5Query);
  if (result.success && result.videos?.length) {
    const video = result.videos.find(v => isFunnyVideoValid(v));
    if (video) {
      return { video, level: 5, searchQuery: level5Query, fallbackUsed: true };
    }
  }
  
  const ultimateFallback = `funny cats compilation ${CURRENT_YEAR}`;
  console.log(`[Video Funnel] Ultimate fallback: "${ultimateFallback}"`);
  result = searchYouTubeVideo(ultimateFallback);
  if (result.success && result.videos?.length) {
    const video = result.videos.find(v => isFunnyVideoValid(v));
    if (video) {
      return { video, level: 5, searchQuery: ultimateFallback, fallbackUsed: true };
    }
  }
  
  const lastResort = 'cute cats being cats';
  console.log(`[Video Funnel] Last resort: "${lastResort}"`);
  result = searchYouTubeVideo(lastResort);
  if (result.success && result.videos?.length) {
    const video = result.videos.find(v => isFunnyVideoValid(v));
    if (video) {
      return { video, level: 5, searchQuery: lastResort, fallbackUsed: true };
    }
  }
  
  const viralQueries = [
    'funniest cat videos viral',
    'most viewed cat videos all time',
    'viral cat videos millions views',
    'hilarious cats funny compilation'
  ];
  
  for (const viralQuery of viralQueries) {
    console.log(`[Video Funnel] 🔥 Viral cat search: "${viralQuery}"`);
    result = searchYouTubeVideo(viralQuery);
    if (result.success && result.videos?.length) {
      const catVideos = result.videos.filter(v => CAT_REGEX.test(v.title));
      if (catVideos.length > 0) {
        const sortedByViews = catVideos.sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0));
        const topVideo = sortedByViews[0];
        console.log(`[Video Funnel] ✅ Found viral cat video: "${topVideo.title}" (${topVideo.viewCount?.toLocaleString() || 'unknown'} views)`);
        return { video: topVideo, level: 6, searchQuery: viralQuery, fallbackUsed: true };
      }
    }
  }
  
  console.log(`[Video Funnel] ⚠️ No cat video found after all searches - this should never happen`);
  return { video: undefined, level: 0, searchQuery: '', fallbackUsed: false };
}

// Persistent client instance (reused across requests)
let persistentClient: any = null;
let clientStarting = false;

/**
 * Load the @github/copilot-sdk ESM module
 */
async function loadCopilotSDK(): Promise<{ CopilotClient: any; defineTool: any }> {
  if (sdkLoaded) {
    if (sdkError) throw new Error(sdkError);
    return { CopilotClient: CopilotClientClass, defineTool };
  }

  try {
    // Dynamic import for ESM module from CommonJS
    const importFn = new Function('specifier', 'return import(specifier)');
    const sdk = await importFn('@github/copilot-sdk');
    CopilotClientClass = sdk.CopilotClient;
    defineTool = sdk.defineTool;
    sdkLoaded = true;
    console.log('✅ @github/copilot-sdk loaded successfully');
    return { CopilotClient: CopilotClientClass, defineTool };
  } catch (error: any) {
    sdkError = error.message;
    sdkLoaded = true;
    console.error('❌ Failed to load @github/copilot-sdk:', error.message);
    throw error;
  }
}

/**
 * Get or create persistent CopilotClient instance
 * The SDK manages the CLI subprocess internally via JSON-RPC
 */
async function getOrCreateClient(): Promise<any> {
  // Return existing client if running
  if (persistentClient) {
    const state = persistentClient.getState?.();
    if (state === 'connected' || state === 'running') {
      return persistentClient;
    }
  }

  // Prevent concurrent initialization
  if (clientStarting) {
    // Wait for existing initialization
    await new Promise(resolve => setTimeout(resolve, 1000));
    return getOrCreateClient();
  }

  clientStarting = true;

  try {
    const { CopilotClient } = await loadCopilotSDK();

    // Get GitHub token from the correct config directory
    const { execSync } = require('child_process');
    let ghToken: string;
    try {
      // Must exclude any existing GITHUB_TOKEN/GH_TOKEN env vars so gh CLI reads from config file
      const cleanEnv = { ...process.env };
      delete cleanEnv.GITHUB_TOKEN;
      delete cleanEnv.GH_TOKEN;
      delete cleanEnv.COPILOT_GITHUB_TOKEN;

      ghToken = execSync('gh auth token', {
        encoding: 'utf8',
        env: {
          ...cleanEnv,
          GH_CONFIG_DIR: '/home/runner/workspace/.config/gh',
          HOME: '/home/runner'
        }
      }).trim();
      console.log(`🔑 GitHub token acquired (${ghToken.length} chars, starts with ${ghToken.substring(0, 4)})`);
    } catch (e) {
      throw new Error('GitHub auth required. Run: gh auth login');
    }

    // Set environment for the CLI subprocess that SDK spawns
    process.env.GH_TOKEN = ghToken;
    process.env.GITHUB_TOKEN = ghToken;
    process.env.COPILOT_GITHUB_TOKEN = ghToken;
    // Use the WORKSPACE config dir where gh is actually authenticated
    process.env.GH_CONFIG_DIR = '/home/runner/workspace/.config/gh';
    process.env.XDG_CONFIG_HOME = '/home/runner/workspace/.config';
    process.env.HOME = '/home/runner';

    // Create client - SDK spawns CLI subprocess internally
    persistentClient = new CopilotClient({
      cliPath: '/home/runner/workspace/node_modules/.bin/copilot',
      autoStart: true,
      autoRestart: true,
      logLevel: 'error',
      useStdio: true,
    });

    // Wait for client to be ready
    await persistentClient.start();
    console.log('✅ CopilotClient started (SDK manages CLI via JSON-RPC)');

    return persistentClient;
  } finally {
    clientStarting = false;
  }
}

// Cloudflare KV Configuration
const CLOUDFLARE_ACCOUNT_ID = 'bc8e15f958dc350e00c0e39d80ca6941';
const CLOUDFLARE_KV_NAMESPACE_ID = 'bd3b856b2ae147ada9a8d236dd4baf30';
const CLOUDFLARE_ZONE_ID = '646da2c86dbbe1dff196c155381b0704';
const CLOUDFLARE_WORKER_NAME = 'petinsurance';
// V3 has its own category tracking, independent from V2
const CATEGORY_STATUS_PREFIX = 'v3:category:status:';

// V3-EXCLUSIVE CATEGORIES - V3 only works on these, V2 works on others
// This prevents V2 and V3 from competing on the same categories
const V3_EXCLUSIVE_CATEGORIES = [
  'cat-toys-interactive',
  'cat-grooming-tools',
  'cat-travel-accessories',
  'cat-training-products',
  'cat-senior-care',
  'cat-dental-care',
  'cat-outdoor-enclosures',
  'cat-puzzle-feeders',
  'cat-calming-products',
  'cat-subscription-boxes'
];

// ============================================================================
// V3 Category Status Tracking (Durable State in KV)
// ============================================================================

interface CategoryStatus {
  category: string;
  status: 'in_progress' | 'completed';
  articleCount: number;
  expectedCount: number;
  avgSeoScore: number;
  startedAt: string;
  completedAt?: string;
}

interface DiscoveredCategory {
  name: string;
  slug: string;
  estimatedKeywords: number;
  affiliatePotential: 'high' | 'medium' | 'low';
  reasoning: string;
}

// NO FALLBACK CATEGORIES - V3 uses fully autonomous discovery via Copilot CLI
// See .github/skills/category-discovery/SKILL.md for discovery prompt standards
// If discovery fails, system enters cooldown and logs error for manual review

const discoveryState = {
  failureCount: 0,
  lastFailure: null as Date | null,
  cooldownUntil: null as Date | null,
  maxRetries: 3,
  cooldownMinutes: 60,
  loaded: false
};

const DISCOVERY_STATE_KEY = 'v3:discovery:state';

async function loadDiscoveryState(): Promise<void> {
  if (discoveryState.loaded) return;
  
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) { discoveryState.loaded = true; return; }
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${DISCOVERY_STATE_KEY}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (res.ok) {
      const saved = JSON.parse(await res.text());
      discoveryState.failureCount = saved.failureCount || 0;
      discoveryState.lastFailure = saved.lastFailure ? new Date(saved.lastFailure) : null;
      discoveryState.cooldownUntil = saved.cooldownUntil ? new Date(saved.cooldownUntil) : null;
    }
  } catch {}
  discoveryState.loaded = true;
}

async function saveDiscoveryState(): Promise<void> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return;
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${DISCOVERY_STATE_KEY}`;
  try {
    await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        failureCount: discoveryState.failureCount,
        lastFailure: discoveryState.lastFailure?.toISOString() || null,
        cooldownUntil: discoveryState.cooldownUntil?.toISOString() || null
      })
    });
  } catch {}
}

async function saveCategoryStatus(category: string, status: CategoryStatus): Promise<void> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return;
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${CATEGORY_STATUS_PREFIX}${category}`;
  try {
    await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'text/plain' },
      body: JSON.stringify(status)
    });
    addActivityLog('info', `[V3] Category status saved: ${category}`, { status: status.status, articles: status.articleCount });
  } catch (error: any) {
    console.error(`[SEO-V3] Failed to save category status: ${error.message}`);
  }
}

async function getCategoryStatus(category: string): Promise<CategoryStatus | null> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return null;
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${CATEGORY_STATUS_PREFIX}${category}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (!res.ok) return null;
    const text = await res.text();
    return JSON.parse(text) as CategoryStatus;
  } catch {
    return null;
  }
}

async function getCompletedCategories(): Promise<string[]> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return [];
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${CATEGORY_STATUS_PREFIX}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (!res.ok) return [];
    const data = await res.json() as any;
    
    const completed: string[] = [];
    for (const key of data.result || []) {
      const category = key.name.replace(CATEGORY_STATUS_PREFIX, '');
      const status = await getCategoryStatus(category);
      if (status?.status === 'completed') {
        completed.push(category);
      }
    }
    return completed;
  } catch {
    return [];
  }
}

async function countArticlesInCategory(category: string): Promise<number> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return 0;
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${category}:`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (!res.ok) return 0;
    const data = await res.json() as any;
    return data.result?.length || 0;
  } catch {
    return 0;
  }
}

async function canAttemptDiscovery(): Promise<boolean> {
  await loadDiscoveryState();
  if (discoveryState.cooldownUntil && new Date() < discoveryState.cooldownUntil) {
    return false;
  }
  return true;
}

async function recordDiscoveryFailure(): Promise<void> {
  discoveryState.failureCount++;
  discoveryState.lastFailure = new Date();
  if (discoveryState.failureCount >= discoveryState.maxRetries) {
    discoveryState.cooldownUntil = new Date(Date.now() + discoveryState.cooldownMinutes * 60 * 1000);
    addActivityLog('warning', `[V3] Discovery cooldown activated for ${discoveryState.cooldownMinutes} minutes`);
  }
  await saveDiscoveryState();
}

async function recordDiscoverySuccess(): Promise<void> {
  discoveryState.failureCount = 0;
  discoveryState.lastFailure = null;
  discoveryState.cooldownUntil = null;
  await saveDiscoveryState();
}

async function logDiscoveryError(reason: string): Promise<null> {
  // NO FALLBACKS - Log error and return null for manual intervention
  // See .github/skills/error-recovery/SKILL.md for error handling guidelines
  console.error(`[SEO-V3] ❌ Discovery blocked: ${reason}`);
  addActivityLog('error', `[V3] Discovery failed - no fallbacks used. Reason: ${reason}`);
  addActivityLog('warning', `[V3] System in cooldown. Manual intervention may be required.`);
  return null;
}

async function discoverNextCategory(): Promise<DiscoveredCategory | null> {
  if (!await canAttemptDiscovery()) {
    return logDiscoveryError('Discovery in cooldown period - wait for cooldown to expire');
  }

  addActivityLog('info', '[V3] Selecting next category from V3-exclusive list...');

  // V3 uses its exclusive category list - no AI discovery needed
  // This prevents overlap with V2 which discovers its own categories
  const completedCategories = await getCompletedCategories();

  // Find the first V3-exclusive category that hasn't been completed
  const availableCategory = V3_EXCLUSIVE_CATEGORIES.find(slug => !completedCategories.includes(slug));

  if (!availableCategory) {
    addActivityLog('info', '[V3] All V3-exclusive categories completed!');
    return null;
  }

  // Convert slug to proper name
  const categoryName = availableCategory
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  const category: DiscoveredCategory = {
    name: categoryName,
    slug: availableCategory,
    estimatedKeywords: 25,
    affiliatePotential: 'high',
    reasoning: 'V3-exclusive category for Cloudflare AI generation'
  };

  await recordDiscoverySuccess();
  addActivityLog('success', `[V3] Selected category: ${category.name} (V3-exclusive)`, category);
  return category;
}

// Legacy Copilot discovery - kept for reference but not used
async function discoverNextCategoryViaCopilot(): Promise<DiscoveredCategory | null> {
  const completedCategories = await getCompletedCategories();
  const completedList = completedCategories.join(', ') || 'none yet';

  const prompt = `You are a cat niche SEO researcher. Find the next high-value category for catsluvus.com.

ALREADY COMPLETED CATEGORIES (do NOT suggest these):
${completedList}

REQUIREMENTS:
1. Must be cat-related (not dogs, not general pets)
2. Must have affiliate potential (products to recommend)
3. Must have 20+ keyword opportunities
4. Prioritize high commercial intent (buying keywords)

Return ONLY valid JSON (no markdown, no explanation):
{
  "name": "Category Name",
  "slug": "category-slug",
  "estimatedKeywords": 30,
  "affiliatePotential": "high",
  "reasoning": "Brief explanation"
}`;

  try {
    const result = await generateWithCopilotCLI(prompt, 120000, 2);
    if (result) {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const category = JSON.parse(jsonMatch[0]) as DiscoveredCategory;
        if (completedCategories.includes(category.slug)) {
          addActivityLog('warning', `[V3] Copilot suggested completed category: ${category.slug} - retrying discovery`);
          await recordDiscoveryFailure();
          return logDiscoveryError(`Copilot suggested already-completed category: ${category.slug}`);
        }
        await recordDiscoverySuccess();
        addActivityLog('success', `[V3] Discovered category: ${category.name}`, category);
        return category;
      }
    }
    // No valid JSON found in response
    await recordDiscoveryFailure();
    return logDiscoveryError('Copilot response did not contain valid JSON');
  } catch (error: any) {
    console.error(`[SEO-V3] ❌ Copilot discovery failed: ${error.message}`);
    addActivityLog('error', `[V3] Copilot discovery failed: ${error.message}`);
    await recordDiscoveryFailure();
    return logDiscoveryError(`Copilot CLI error: ${error.message}`);
  }
}

async function generateCategoryKeywords(category: DiscoveredCategory): Promise<string[]> {
  addActivityLog('info', `[V3] Generating keywords for: ${category.name}`);
  
  const prompt = `Generate 30-50 SEO keywords for the "${category.name}" category on a cat website (catsluvus.com).

REQUIREMENTS:
1. Mix of informational and commercial intent
2. Include long-tail keywords (3-5 words)
3. Focus on topics with affiliate potential
4. Avoid generic terms like "cat" or "cats" alone
5. Each keyword should be a complete search phrase

Return ONLY a JSON array of keyword strings (no markdown, no explanation):
["keyword one", "keyword two", ...]`;

  try {
    const result = await generateWithCopilotCLI(prompt, 120000, 2);
    if (result) {
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const keywords = JSON.parse(jsonMatch[0]) as string[];
        addActivityLog('success', `[V3] Generated ${keywords.length} keywords for ${category.name}`);
        return keywords;
      }
    }
  } catch (error: any) {
    addActivityLog('error', `[V3] Keyword generation failed: ${error.message}`);
  }
  
  return [];
}

// ============================================================================
// Cloudflare Worker Route Auto-Configuration
// ============================================================================

// Cache of configured routes to avoid duplicate API calls
const configuredRoutes: Set<string> = new Set();

// Retry configuration for Worker Route API calls
const WORKER_ROUTE_MAX_RETRIES = 3;
const WORKER_ROUTE_INITIAL_DELAY_MS = 1000;

/**
 * Helper function for exponential backoff retry
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = WORKER_ROUTE_MAX_RETRIES,
  initialDelayMs: number = WORKER_ROUTE_INITIAL_DELAY_MS
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        const delayMs = initialDelayMs * Math.pow(2, attempt);
        console.log(`[SEO-V3] Retry ${attempt + 1}/${maxRetries} after ${delayMs}ms: ${error.message}`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Helper to fetch current Worker routes from Cloudflare
 */
async function fetchWorkerRoutes(cfApiToken: string): Promise<any[]> {
  const listUrl = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/workers/routes`;
  const listRes = await fetch(listUrl, {
    headers: { 'Authorization': `Bearer ${cfApiToken}` }
  });
  if (!listRes.ok) {
    throw new Error(`Failed to list routes: ${listRes.status} ${listRes.statusText}`);
  }
  return (await listRes.json() as any).result || [];
}

/**
 * Automatically configure a Cloudflare Worker Route for a new V3 category
 * Creates route pattern: catsluvus.com/{category}/* -> petinsurance Worker
 * This enables the public domain to route V3 category URLs to the Worker
 * 
 * Features:
 * - Automatic retry with exponential backoff (3 attempts)
 * - Creates routes for both www and non-www variants
 * - Caches successful configurations to avoid duplicate API calls
 * - Handles 409/conflict errors as success (route already exists)
 * - Re-fetches route list before each create to avoid stale state
 * - Returns partial status when some routes fail
 */
async function ensureWorkerRouteForCategory(category: string): Promise<{ success: boolean; partial?: boolean; error?: string; routeId?: string }> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) {
    console.log('[SEO-V3] No Cloudflare API token - skipping Worker Route configuration');
    addActivityLog('warning', `[V3] Worker Route skipped: No API token`, { category });
    return { success: false, error: 'No API token' };
  }

  // Skip if already configured this session
  if (configuredRoutes.has(category)) {
    console.log(`[SEO-V3] Worker Route already configured for ${category} (cached)`);
    return { success: true };
  }

  const routePattern = `catsluvus.com/${category}/*`;
  const listUrl = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/workers/routes`;
  
  try {
    // First, check if primary route already exists (with retry)
    const existingRoutes = await retryWithBackoff(async () => fetchWorkerRoutes(cfApiToken));
    
    const existingRoute = existingRoutes.find((r: any) => r.pattern === routePattern);
    if (existingRoute) {
      console.log(`[SEO-V3] ✓ Worker Route already exists: ${routePattern} (ID: ${existingRoute.id})`);
      configuredRoutes.add(category);
      return { success: true, routeId: existingRoute.id };
    }

    // Create routes for both catsluvus.com and www.catsluvus.com
    // Also create routes for both /{category}/* and /{category} (index)
    const routePatterns = [
      `catsluvus.com/${category}/*`,
      `catsluvus.com/${category}`,
      `www.catsluvus.com/${category}/*`,
      `www.catsluvus.com/${category}`
    ];
    
    let successCount = 0;
    let failedPatterns: string[] = [];
    let lastRouteId = '';
    
    for (const pattern of routePatterns) {
      // Re-fetch routes before each create to avoid stale state
      let currentRoutes: any[];
      try {
        currentRoutes = await retryWithBackoff(async () => fetchWorkerRoutes(cfApiToken));
      } catch (err: any) {
        console.warn(`[SEO-V3] Failed to refresh route list: ${err.message}, using cached`);
        currentRoutes = existingRoutes;
      }
      
      // Check if this specific pattern already exists
      if (currentRoutes.some((r: any) => r.pattern === pattern)) {
        console.log(`[SEO-V3] ✓ Route already exists: ${pattern}`);
        successCount++;
        continue;
      }
      
      // Create route with retry
      try {
        const result = await retryWithBackoff(async () => {
          console.log(`[SEO-V3] Creating Worker Route: ${pattern} -> ${CLOUDFLARE_WORKER_NAME}`);
          const createRes = await fetch(listUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${cfApiToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              pattern: pattern,
              script: CLOUDFLARE_WORKER_NAME
            })
          });

          const createData = await createRes.json() as any;
          
          // Handle 409 conflict or "route already exists" as success
          if (createRes.status === 409 || 
              createData.errors?.some((e: any) => e.message?.includes('already exists') || e.code === 10020)) {
            console.log(`[SEO-V3] ✓ Route already exists (conflict): ${pattern}`);
            return { id: 'exists', conflict: true };
          }
          
          if (!createRes.ok || !createData.success) {
            const errorMsg = createData.errors?.[0]?.message || `HTTP ${createRes.status}`;
            throw new Error(errorMsg);
          }
          
          return createData.result;
        });
        
        if (result?.conflict) {
          successCount++;
        } else {
          console.log(`[SEO-V3] ✓ Worker Route created: ${pattern} (ID: ${result?.id})`);
          lastRouteId = result?.id || lastRouteId;
          successCount++;
        }
      } catch (error: any) {
        console.error(`[SEO-V3] ⚠️ Failed to create route ${pattern} after ${WORKER_ROUTE_MAX_RETRIES} retries: ${error.message}`);
        failedPatterns.push(pattern);
      }
    }
    
    const totalPatterns = routePatterns.length;
    const isPartial = successCount > 0 && failedPatterns.length > 0;
    const isFullSuccess = successCount === totalPatterns;
    
    if (isFullSuccess) {
      configuredRoutes.add(category);
      addActivityLog('success', `[V3] Worker Routes configured: ${category}`, {
        routesCreated: successCount,
        patterns: routePatterns
      });
      return { success: true, routeId: lastRouteId };
    } else if (isPartial) {
      // Partial success - don't cache, allow retry next time
      addActivityLog('warning', `[V3] Worker Routes partial: ${category}`, {
        routesCreated: successCount,
        routesFailed: failedPatterns.length,
        patterns: routePatterns,
        failedPatterns
      });
      console.warn(`[SEO-V3] ⚠️ Partial success for ${category}: ${successCount}/${totalPatterns} routes created`);
      return { success: true, partial: true, routeId: lastRouteId, error: `${failedPatterns.length} routes failed: ${failedPatterns.join(', ')}` };
    } else {
      addActivityLog('error', `[V3] All Worker Routes failed: ${category}`, {
        failedPatterns,
        lastError: 'All retry attempts exhausted'
      });
      return { success: false, error: `All routes failed after ${WORKER_ROUTE_MAX_RETRIES} retries each` };
    }
  } catch (error: any) {
    console.error(`[SEO-V3] ❌ Worker Route error: ${error.message}`);
    addActivityLog('error', `[V3] Worker Route error: ${category}`, { error: error.message });
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Duplicate Tracking - Fetch existing articles from KV
// ============================================================================

// Cache of existing article slugs (refreshed periodically)
let existingArticleSlugs: Set<string> = new Set();
let slugsCacheTime: number = 0;
const SLUGS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch all existing article slugs from Cloudflare KV
 * Uses the KV list API to get all keys
 */
async function fetchExistingArticleSlugs(): Promise<Set<string>> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) {
    console.warn('No Cloudflare API token - cannot check for duplicates');
    return new Set();
  }

  // Return cached if still valid
  if (existingArticleSlugs.size > 0 && Date.now() - slugsCacheTime < SLUGS_CACHE_TTL) {
    return existingArticleSlugs;
  }

  try {
    const slugs = new Set<string>();
    let cursor: string | undefined;

    // Paginate through all KV keys
    do {
      const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?limit=1000${cursor ? `&cursor=${cursor}` : ''}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.error('Failed to fetch KV keys:', response.status);
        break;
      }

      const data = await response.json() as any;

      // Filter out system keys (sitemap.xml, etc) and add article slugs
      for (const key of data.result || []) {
        const name = key.name;
        // Skip system keys
        if (name === 'sitemap.xml' || name.startsWith('gsc_') || name.startsWith('seo:')) {
          continue;
        }
        slugs.add(name);
      }

      cursor = data.result_info?.cursor;
    } while (cursor);

    existingArticleSlugs = slugs;
    slugsCacheTime = Date.now();

    console.log(`📊 Fetched ${slugs.size} existing article slugs from KV`);
    
    const petinsuranceSlugs = Array.from(slugs).filter(s => !s.includes(':'));
    if (petinsuranceSlugs.length > 0) {
      bulkRegisterArticles(petinsuranceSlugs, 'petinsurance');
    }
    
    return slugs;
  } catch (error: any) {
    console.error('Error fetching KV keys:', error.message);
    return existingArticleSlugs; // Return cached even if stale
  }
}

/**
 * Fetch existing article slugs for V3 category (filtered by kvPrefix)
 */
async function fetchExistingArticleSlugs(kvPrefix: string): Promise<string[]> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return [];

  try {
    const slugs: string[] = [];
    let cursor: string | undefined;

    do {
      const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(kvPrefix)}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) break;

      const data = await response.json() as any;
      for (const key of data.result || []) {
        // Remove the prefix to get just the slug
        const slug = key.name.replace(kvPrefix, '');
        if (slug && !slug.includes(':') && slug !== 'sitemap.xml' && slug !== 'research-output') {
          slugs.push(slug);
        }
      }

      cursor = data.result_info?.cursor;
    } while (cursor);

    if (slugs.length > 0) {
      const category = kvPrefix.replace(':', '').replace(/-/g, '-');
      bulkRegisterArticles(slugs, category || 'cat-trees-condos');
    }
    
    return slugs;
  } catch (error: any) {
    console.error('[SEO-V3] Error fetching V2 slugs:', error.message);
    return [];
  }
}

/**
 * Fetch cross-category articles for internal linking (V3)
 * Returns articles from OTHER V3 categories (not the current one) with full URLs
 * V3 is kept separate from V1 petinsurance - uses only V3-exclusive categories
 */
async function fetchCrossCategoryArticlesForLinking(currentCategoryKvPrefix: string): Promise<string[]> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return [];

  const articlesWithUrls: string[] = [];

  // Normalize current category: remove trailing colon for comparison
  // e.g., "cat-carriers-travel-products:" -> "cat-carriers-travel-products"
  const currentCategoryNormalized = currentCategoryKvPrefix.replace(/:$/, '');

  try {
    // V3-only cross-category linking (no V1 petinsurance - V3 separate from V1)
    // Fetch articles from V3-exclusive categories (excluding current category)
    const v3Categories = V3_EXCLUSIVE_CATEGORIES
      .filter(cat => cat !== currentCategoryNormalized); // Exact match comparison

    for (const category of v3Categories.slice(0, 3)) { // Limit to 3 other categories
      const catUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${encodeURIComponent(category + ':')}&limit=20`;
      const catResponse = await fetch(catUrl, {
        headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'application/json' }
      });

      if (catResponse.ok) {
        const catData = await catResponse.json() as any;
        const catArticles = (catData.result || [])
          .filter((key: any) => {
            const name = key.name;
            // Skip non-article keys
            return !name.includes('sitemap') && 
                   !name.includes('research') && 
                   !name.includes('status') &&
                   name.includes(':'); // Must be category:slug format
          })
          .slice(0, 10)
          .map((key: any) => {
            const colonIndex = key.name.indexOf(':');
            if (colonIndex === -1) return null;
            const catPrefix = key.name.substring(0, colonIndex);
            const slug = key.name.substring(colonIndex + 1);
            if (!slug || slug.length < 3) return null;
            return `/${catPrefix}/${slug}`;
          })
          .filter((url: string | null) => url !== null);
        
        articlesWithUrls.push(...catArticles);
      }
    }

    console.log(`[Internal Linking] Fetched ${articlesWithUrls.length} V3 cross-category articles (V3-only, no V1 links)`);
    return articlesWithUrls;
  } catch (error: any) {
    console.error('[Internal Linking] Error fetching cross-category articles:', error.message);
    return [];
  }
}

/**
 * Build V3 article HTML with category-specific context
 */
function buildArticleHtml(
  article: ArticleData,
  slug: string,
  keyword: string,
  context: CategoryContext,
  video?: YouTubeVideo,
  generatedImages?: GeneratedImage[],
  amazonProductData?: AmazonProductData
): string {
  // Robust CategoryContext guards - use safe defaults for all fields
  // CRITICAL: Always prefer niche over hardcoded fallback for dynamic categories
  const safeDomain = context?.domain || 'catsluvus.com';
  const safeCategoryName = context?.categoryName || context?.niche || 'Cat Care';
  // Derive basePath from categorySlug, category, or compute from categoryName
  const derivedSlug = context?.categorySlug || context?.category || 
    (safeCategoryName !== 'Cat Care' ? safeCategoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : 'cat-care');
  const safeBasePath = context?.basePath || `/${derivedSlug}`;
  const safeSiteName = context?.branding?.siteName || 'CatsLuvUs';
  
  // Get category-specific author from CategoryContentData
  const categorySlugForAuthor = context?.categorySlug || context?.niche || 'DEFAULT';
  const categoryContentForAuthor = getCategoryContentData(categorySlugForAuthor);
  
  const author = (context?.authors && context.authors.length > 0 && context.authors[0]) || {
    name: categoryContentForAuthor.author.name,
    title: categoryContentForAuthor.author.title,
    credentials: categoryContentForAuthor.author.credentials,
    bio: categoryContentForAuthor.author.bio,
    image: 'https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=100&h=100&fit=crop'
  };

  const dateNow = new Date().toISOString().split('T')[0];
  const canonicalUrl = `https://${safeDomain}${safeBasePath}/${slug}`;

  // Build FAQ schema
  const faqSchema = article.faqs && article.faqs.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": article.faqs.map(faq => ({
      "@type": "Question",
      "name": faq.question,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": faq.answer.replace(/<[^>]*>/g, '').substring(0, 500)
      }
    }))
  } : null;

  // Build Article schema
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": article.title,
    "description": article.metaDescription,
    "datePublished": dateNow,
    "dateModified": dateNow,
    "author": {
      "@type": "Person",
      "name": author.name,
      "jobTitle": author.title
    },
    "publisher": {
      "@type": "Organization",
      "name": safeSiteName,
      "logo": {
        "@type": "ImageObject",
        "url": `https://${safeDomain}/logo.png`
      }
    },
    "mainEntityOfPage": canonicalUrl
  };

  // Build VideoObject schema if video exists (use correct YouTubeVideo interface fields)
  const videoSchema = video ? {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "name": video.title,
    "description": video.description || `Video about ${keyword}`,
    "thumbnailUrl": video.thumbnailUrl,
    "uploadDate": video.publishedISO || video.published || dateNow,
    "contentUrl": video.watchUrl || `https://www.youtube.com/watch?v=${video.videoId}`,
    "embedUrl": video.embedUrl || `https://www.youtube.com/embed/${video.videoId}`,
    "duration": video.durationISO || undefined,
    "interactionStatistic": video.viewCount ? {
      "@type": "InteractionCounter",
      "interactionType": "WatchAction",
      "userInteractionCount": video.viewCount
    } : undefined
  } : null;

  // Build breadcrumb schema
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": `https://${safeDomain}` },
      { "@type": "ListItem", "position": 2, "name": safeCategoryName, "item": `https://${safeDomain}${safeBasePath}` },
      { "@type": "ListItem", "position": 3, "name": article.title }
    ]
  };

    // Build Product schema from real Amazon data (preferred) or AI-generated comparison table
  // Priority: 1) Real Amazon products, 2) AI-generated, 3) Category defaults
  const articleComparisonData = article.comparisonTable;
  const categoryContentForProducts = getCategoryContentData(categorySlugForAuthor);

  let productSchema: object | null = null;

  // Use real Amazon product schema if we have it
  if (amazonProductData && amazonProductData.productSchemaItems.length > 0) {
    productSchema = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": `Best ${keyword} Comparison`,
      "description": `Comparison of top ${keyword} products with real Amazon prices and ratings`,
      "itemListElement": amazonProductData.productSchemaItems
    };
    console.log(`[SEO-V3] ✅ Product schema from REAL Amazon data (${amazonProductData.products.length} products with ASINs)`);
  } else if (articleComparisonData && articleComparisonData.rows && articleComparisonData.rows.length > 0) {
    productSchema = generateProductSchema(
      articleComparisonData.headers || [],
      articleComparisonData.rows || [],
      article.externalLinks || categoryContentForProducts.externalLinks || [],
      keyword
    );
    if (productSchema) {
      console.log(`[SEO-V3] ✅ Product schema from AI-generated data (${articleComparisonData.rows.length} products)`);
    }
  } else if (categoryContentForProducts && categoryContentForProducts.comparisonRows && categoryContentForProducts.comparisonRows.length > 0) {
    productSchema = generateProductSchema(
      categoryContentForProducts.comparisonHeaders || [],
      categoryContentForProducts.comparisonRows || [],
      categoryContentForProducts.externalLinks || [],
      keyword
    );
    if (productSchema) {
      console.log(`[SEO-V3] ⚠️ Product schema from category defaults (${categoryContentForProducts.comparisonRows.length} products)`);
    }
  }

  // Build comparison table HTML with Amazon affiliate links
  const amazonTag = process.env.AMAZON_AFFILIATE_TAG || 'catsluvus03-20';
  let comparisonTableHtml = '';
  if (article.comparisonTable && article.comparisonTable.headers && article.comparisonTable.rows) {
    // Check if last column is Amazon Search - replace with clickable link
    const hasAmazonColumn = article.comparisonTable.headers.some(h => 
      h.toLowerCase().includes('amazon') || h.toLowerCase().includes('buy') || h.toLowerCase().includes('link')
    );
    
    // Build headers - replace Amazon Search with "Buy Now" column
    const displayHeaders = hasAmazonColumn 
      ? [...article.comparisonTable.headers.slice(0, -1), 'Buy Now']
      : article.comparisonTable.headers;
    
    comparisonTableHtml = `
      <div class="comparison-table">
        <table>
          <thead>
            <tr>${displayHeaders.map(h => `<th>${h}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${article.comparisonTable.rows.map(row => {
              if (hasAmazonColumn && row.length >= 5) {
                // Last column contains Amazon search query - convert to affiliate link
                const amazonSearch = row[row.length - 1] || row[0].replace(/\s+/g, '+');
                const amazonUrl = `https://www.amazon.com/s?k=${encodeURIComponent(amazonSearch.replace(/\+/g, ' '))}&tag=${amazonTag}`;
                const displayCells = row.slice(0, -1);
                return `<tr>${displayCells.map(cell => `<td>${cell}</td>`).join('')}<td><a href="${amazonUrl}" target="_blank" rel="nofollow sponsored" class="amazon-btn">Buy on Amazon</a></td></tr>`;
              }
              return `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // Helper function to build image HTML with lazy loading and ImageObject schema
  // Uses intrinsic sizing (width/height for aspect ratio) with responsive CSS override
  const buildImageHtml = (image: GeneratedImage): string => {
    return `
      <figure class="article-image" itemscope itemtype="https://schema.org/ImageObject">
        <img
          src="${image.url}"
          alt="${image.alt.replace(/"/g, '&quot;')}"
          width="${image.width}"
          height="${image.height}"
          style="width: 100%; height: auto; max-width: 100%;"
          loading="lazy"
          decoding="async"
          itemprop="contentUrl"
        >
        <figcaption itemprop="caption">${image.caption}</figcaption>
        <meta itemprop="width" content="${image.width}">
        <meta itemprop="height" content="${image.height}">
      </figure>
    `;
  };

  // Get hero image (always generated)
  const heroImage = generatedImages?.find(img => img.imageType === 'hero');
  const heroImageHtml = heroImage ? buildImageHtml(heroImage) : '';

  // Note: Closing images removed per SEO best practices (1-2 images max)
  // Only hero + optional mid-article section image are generated now

  // Build sections HTML with AI-generated images after each H2
  let sectionsHtml = '';
  if (article.sections && Array.isArray(article.sections)) {
    sectionsHtml = article.sections.map((section, index) => {
      // Find matching section image (sectionIndex is 1-based)
      const sectionImage = generatedImages?.find(
        img => img.imageType === 'section' && img.sectionIndex === index + 1
      );
      const sectionImageHtml = sectionImage ? buildImageHtml(sectionImage) : '';

      return `
        <section>
          <h2>${section.heading}</h2>
          ${sectionImageHtml}
          ${section.content}
        </section>
      `;
    }).join('');
  }

  // Build FAQ HTML
  let faqHtml = '';
  if (article.faqs && article.faqs.length > 0) {
    faqHtml = `
      <section class="faqs">
        <h2>Frequently Asked Questions About ${keyword}</h2>
        ${article.faqs.map(faq => `
          <div class="faq-item">
            <h3>${faq.question}</h3>
            <p>${faq.answer}</p>
          </div>
        `).join('')}
      </section>
    `;
  }

  // Build video hero HTML - prominent placement for Google Video indexing
  let videoHeroHtml = '';
  if (video) {
    videoHeroHtml = `
      <section class="video-hero" id="video">
        <p class="video-hero-title">Watch: Expert Guide on ${keyword}</p>
        <div class="video-container">
          <iframe width="560" height="315" src="${video.embedUrl || `https://www.youtube.com/embed/${video.videoId}`}?rel=0&modestbranding=1" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="eager" title="${video.title}"></iframe>
        </div>
        <p class="video-hero-meta"><strong>${video.channel}</strong> • ${video.duration || ''} • ${video.views || ''}</p>
        <p class="video-hero-cta">Continue reading below for our complete written guide with pricing, comparisons, and FAQs.</p>
      </section>
    `;
  }

  // NOTE: Navigation menu items now handled by Worker HTMLRewriter injection

  const currentYear = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<!-- Google AdSense -->
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9364522191686432" crossorigin="anonymous"></script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${article.title}</title>
<meta name="description" content="${article.metaDescription}">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:title" content="${article.title}">
<meta property="og:description" content="${article.metaDescription}">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(articleSchema)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbSchema)}</script>
${faqSchema ? `<script type="application/ld+json">${JSON.stringify(faqSchema)}</script>` : ''}
${videoSchema ? `<script type="application/ld+json">${JSON.stringify(videoSchema)}</script>` : ''}
${productSchema ? `<script type="application/ld+json">${JSON.stringify(productSchema)}</script>` : ''}
<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-KPSXGQWC');</script>
<style>
/* CSS Custom Properties */
:root {
  --wc-color-primary: #326891;
  --wc-color-primary-dark: #265073;
  --wc-color-text: #121212;
  --wc-color-text-secondary: #555555;
  --wc-color-border: #e2e2e2;
  --wc-color-bg: #ffffff;
  --wc-color-bg-hover: #f8f8f8;
  --wc-transition-speed: 300ms;
}

/* Reset & Base */
*{box-sizing:border-box;margin:0;padding:0}
html,body{overflow-x:hidden;width:100%;max-width:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.8;color:var(--wc-color-text);background:var(--wc-color-bg)}

/* Skip Link for Accessibility */
.skip-link{position:absolute;top:-40px;left:0;background:#333;color:#fff;padding:8px 16px;text-decoration:none;border-radius:0 0 4px 0;z-index:99999}
.skip-link:focus{top:0}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* NOTE: Navigation chrome (hamburger, nav, footer) injected by Worker HTMLRewriter */

/* Main Content */
main{padding-top:70px;overflow-x:hidden}
.container{max-width:720px;margin:0 auto;padding:40px 24px;overflow-wrap:break-word;word-wrap:break-word;overflow-x:hidden}

/* Typography */
body{font-size:18px;line-height:1.75;letter-spacing:-0.01em}
article{font-size:18px;line-height:1.8;color:#1a1a1a;overflow-wrap:break-word;word-wrap:break-word}
article p{margin-bottom:1.5em;text-align:left;word-spacing:0.05em;overflow-wrap:break-word;hyphens:auto;-webkit-hyphens:auto}
h1{font-size:2rem;margin-bottom:20px;color:var(--wc-color-primary);line-height:1.3;letter-spacing:-0.02em}
h2{font-size:1.4rem;margin:48px 0 24px;border-bottom:2px solid var(--wc-color-border);padding-bottom:12px;line-height:1.4}
h3{font-size:1.15rem;margin:32px 0 16px;line-height:1.4}
p{margin-bottom:1.25em;overflow-wrap:break-word;hyphens:auto;-webkit-hyphens:auto}
ul,ol{margin:1.25em 0 1.5em 1.5em;line-height:1.7}
li{margin-bottom:0.5em;overflow-wrap:break-word}
a{color:var(--wc-color-primary)}

/* Prevent content overflow */
article img,article video,article iframe,article embed,article object{max-width:100%;height:auto;display:block}
article pre,article code{overflow-x:auto;max-width:100%;white-space:pre-wrap;word-wrap:break-word}
a{overflow-wrap:break-word;word-break:break-all}
article *{max-width:100%}

/* Breadcrumb */
.breadcrumb{font-size:14px;margin-bottom:20px;padding-top:10px}
.breadcrumb a{color:var(--wc-color-primary);text-decoration:none}

/* Article Images */
.article-image{margin:30px 0;text-align:center}
.article-image img{max-width:100%;height:auto;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
.article-image figcaption{font-size:14px;color:#666;margin-top:10px;font-style:italic}

/* Author Box */
.author-box{display:flex;gap:16px;padding:20px;background:#f8f9fa;border-radius:8px;margin:24px 0;border-left:4px solid var(--wc-color-primary)}
.author-box img{width:80px;height:80px;border-radius:50%;object-fit:cover;flex-shrink:0}
.author-info h4{margin:0 0 4px;color:var(--wc-color-primary)}
.author-info .credentials{font-size:14px;color:#666;margin-bottom:8px}
.author-info .bio{font-size:15px;line-height:1.6}

/* Quick Answer Box */
.quick-answer{background:#fff3cd;border:2px solid #ffc107;border-radius:8px;padding:20px 25px;margin:20px 0 30px 0;font-size:1.1em;line-height:1.7}
.quick-answer strong{color:#856404;display:block;margin-bottom:8px;font-size:0.95em;text-transform:uppercase;letter-spacing:0.5px}

/* Key Takeaways */
.key-takeaways{background:linear-gradient(135deg,#e8f4f8 0%,#d4e8ed 100%);border-left:4px solid var(--wc-color-primary);padding:20px 25px;border-radius:0 8px 8px 0;margin:30px 0}
.key-takeaways h2,.key-takeaways strong{font-size:1.2rem;margin:0 0 15px 0;color:var(--wc-color-primary)}
.key-takeaways ul{margin:0;padding-left:20px}
.key-takeaways li{margin:8px 0;line-height:1.6}

/* Comparison Table */
.comparison-table{overflow-x:auto;margin:30px 0;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
.comparison-table table{width:100%;border-collapse:collapse;min-width:500px}
.comparison-table th,.comparison-table td{padding:14px 16px;border:1px solid var(--wc-color-border);text-align:left}
.comparison-table th{background:#f8fafc;font-weight:700;color:var(--wc-color-text)}
.comparison-table tr:nth-child(even){background:#fafbfc}
.comparison-table tr:hover{background:#e8f4f8}
.amazon-btn{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(180deg,#ff9900 0%,#e47911 100%);color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;border:none;box-shadow:0 4px 14px rgba(255,153,0,0.4);transition:all 0.3s ease;white-space:nowrap}
.amazon-btn:hover{background:linear-gradient(180deg,#ffad33 0%,#ff9900 100%);transform:translateY(-2px);box-shadow:0 6px 20px rgba(255,153,0,0.5);text-decoration:none;color:#fff}
.amazon-btn::before{content:'';display:inline-block;width:20px;height:20px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='white'%3E%3Cpath d='M15.75 10.5V6a3.75 3.75 0 1 0-7.5 0v4.5m11.356-1.993 1.263 12c.07.665-.45 1.243-1.119 1.243H4.25a1.125 1.125 0 0 1-1.12-1.243l1.264-12A1.125 1.125 0 0 1 5.513 7.5h12.974c.576 0 1.059.435 1.119 1.007ZM8.625 10.5a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm7.5 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z'/%3E%3C/svg%3E");background-size:contain;background-repeat:no-repeat}
.amazon-btn:active{transform:translateY(0);box-shadow:0 2px 8px rgba(255,153,0,0.4)}

/* FAQ Section */
.faqs{background:#f8f8f8;padding:24px;border-radius:8px;margin:40px 0}
.faq-item{margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--wc-color-border)}
.faq-item:last-child{margin-bottom:0;padding-bottom:0;border-bottom:none}
.faq-item h3{color:var(--wc-color-primary);margin-bottom:8px;margin-top:0}

/* Video Hero Section */
.video-hero{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:24px;border-radius:12px;margin:20px 0 32px;box-shadow:0 8px 32px rgba(0,0,0,0.15)}
.video-hero-title{color:#fff;font-size:1.1rem;margin:0 0 16px;font-weight:600;display:flex;align-items:center;gap:8px}
.video-hero-title::before{content:'▶';color:#ff6b35;font-size:0.9rem}
.video-hero .video-container{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,0,0,0.3)}
.video-hero .video-container iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:none;border-radius:8px}
.video-hero-meta{color:#b8b8b8;font-size:14px;margin:0;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.video-hero-meta strong{color:#fff}
.video-hero-cta{color:#ff6b35;font-size:13px;margin-top:12px;font-style:italic}

/* Video Container (fallback) */
.video-container{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:8px;margin-bottom:12px}
.video-container iframe{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:8px}

/* Conclusion */
.conclusion{background:linear-gradient(135deg,#326891,#265073);color:#fff;padding:24px;border-radius:8px;margin:40px 0}
.conclusion h2{color:#fff;border-bottom-color:rgba(255,255,255,0.3)}

/* Disclaimer */
.disclaimer{background:#f8f9fa;padding:12px 20px;text-align:center;font-size:14px;border-bottom:1px solid #e5e5e5}
.disclaimer a{color:#d63384;text-decoration:none}

/* Footer */
.site-footer{background:#1a1a1a;color:#fff;padding:60px 20px 40px;margin-top:60px}
.footer-content{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:40px}
.footer-section h4{font-size:16px;margin-bottom:16px;color:#fff}
.footer-section ul{list-style:none;padding:0;margin:0}
.footer-section li{margin-bottom:8px}
.footer-section a{color:#aaa;text-decoration:none;font-size:14px}
.footer-section a:hover{color:#fff}
.footer-bottom{max-width:1200px;margin:40px auto 0;padding-top:20px;border-top:1px solid #333;text-align:center;color:#666;font-size:13px}
.footer-bottom a{color:#888;text-decoration:none;margin:0 12px}

/* Responsive */
@media (max-width:768px){
  body{font-size:17px}
  article{font-size:17px;line-height:1.75}
  h1{font-size:1.6rem}
  h2{font-size:1.25rem;margin:36px 0 18px}
  h3{font-size:1.1rem}
  .container{padding:32px 20px}
  .author-box{flex-direction:column;text-align:center}
  .author-box img{margin:0 auto}
  .footer-content{grid-template-columns:1fr 1fr}
}
@media (max-width:480px){
  body{font-size:16px}
  article{font-size:16px;line-height:1.7}
  h1{font-size:1.4rem}
  .container{padding:24px 16px}
  .footer-content{grid-template-columns:1fr}
  .key-takeaways{padding:16px 18px}
  .faqs{padding:18px}
  .conclusion{padding:18px}
}

/* Reduced Motion */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:0.01ms !important;transition-duration:0.01ms !important}
}

/* Print - hide chrome elements injected by Worker */
@media print{
  .hamburger-menu,.nav-menu,.universal-footer,.skip-link{display:none !important}
  body{padding-top:0}
}
</style>
</head>
<body>
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-KPSXGQWC" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>

<!-- NOTE: Navigation chrome (hamburger, nav, footer) injected by Worker HTMLRewriter -->

<!-- Disclaimer Banner -->
<div class="disclaimer">
  We independently review everything we recommend. When you buy through our links, we may earn a commission.
  <a href="https://${safeDomain}/affiliate-disclosure/">Learn more ›</a>
</div>

<main id="main-content">
<div class="container">
<nav class="breadcrumb" aria-label="Breadcrumb">
  <a href="https://${safeDomain}">Home</a> ›
  <a href="https://${safeDomain}${safeBasePath}">${safeCategoryName}</a> ›
  ${article.title}
</nav>

<article itemscope itemtype="https://schema.org/Article">
  <h1 itemprop="headline">${article.title}</h1>

  ${videoHeroHtml}

  <div class="author-box" itemprop="author" itemscope itemtype="https://schema.org/Person">
    <img src="${author.image || 'https://images.unsplash.com/photo-1559839734-2b71ea197ec2?w=100&h=100&fit=crop'}" alt="${author.name}" itemprop="image" loading="lazy">
    <div class="author-info">
      <h4 itemprop="name">${author.name}</h4>
      <p class="credentials" itemprop="jobTitle">${author.title}</p>
      <p class="bio">${author.credentials}</p>
    </div>
  </div>

  <p class="disclosure">Disclosure: This article may contain affiliate links. We may earn a commission when you purchase through our links at no extra cost to you.</p>

  ${article.quickAnswer ? `
    <div class="quick-answer" itemprop="description">
      <strong>Quick Answer:</strong> ${article.quickAnswer}
    </div>
  ` : ''}

  ${article.keyTakeaways && article.keyTakeaways.length > 0 ? `
    <div class="key-takeaways">
      <strong>Key Takeaways:</strong>
      <ul>
        ${article.keyTakeaways.map(t => `<li>${t}</li>`).join('')}
      </ul>
    </div>
  ` : ''}

  ${heroImageHtml}

  <div class="introduction" itemprop="articleBody">
    ${article.introduction || ''}
  </div>

  ${sectionsHtml}

  ${comparisonTableHtml}

  ${faqHtml}

  <section class="conclusion">
    <h2>Conclusion</h2>
    ${article.conclusion || ''}
  </section>
</article>
</div>
</main>
<!-- NOTE: Footer and menu JS injected by Worker HTMLRewriter -->
</body>
</html>`;
}

/**
 * Update V3 sitemap with new article
 */
async function updateSitemap(slug: string, context: CategoryContext): Promise<void> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return;

  // Robust CategoryContext guards - derive from categorySlug if available
  const derivedSlug = context?.categorySlug || 'v3-articles';
  const safeKvPrefix = context?.kvPrefix || `${derivedSlug}:`;
  const safeDomain = context?.domain || 'catsluvus.com';
  const safeBasePath = context?.basePath || `/${derivedSlug}`;

  try {
    const sitemapKey = `${safeKvPrefix}sitemap.xml`;
    const articleUrl = `https://${safeDomain}${safeBasePath}/${slug}`;
    const today = new Date().toISOString().split('T')[0];

    // Fetch existing sitemap
    const getUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(sitemapKey)}`;
    let existingSitemap = '';
    
    try {
      const response = await fetch(getUrl, {
        headers: { 'Authorization': `Bearer ${cfApiToken}` }
      });
      if (response.ok) {
        existingSitemap = await response.text();
      }
    } catch {}

    // If no sitemap exists, create new one
    if (!existingSitemap || !existingSitemap.includes('<?xml')) {
      existingSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://${safeDomain}${safeBasePath}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
    }

    // Check if URL already exists
    if (existingSitemap.includes(articleUrl)) {
      return;
    }

    // Add new URL before closing </urlset>
    const newEntry = `  <url>
    <loc>${articleUrl}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`;

    const updatedSitemap = existingSitemap.replace('</urlset>', newEntry);

    // Save updated sitemap
    const putUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(sitemapKey)}`;
    await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'application/xml' },
      body: updatedSitemap
    });

    console.log(`[SEO-V3] 🗺️ Sitemap updated: ${slug}`);
  } catch (error: any) {
    console.error('[SEO-V3] Sitemap update error:', error.message);
  }
}

/**
 * Check if an article already exists in KV
 */
async function articleExists(slug: string): Promise<boolean> {
  const slugs = await fetchExistingArticleSlugs();
  return slugs.has(slug);
}

/**
 * Get the next prioritized keyword that hasn't been generated yet
 * ATOMIC: Immediately adds the returned keyword to keywordsInProgress to prevent race conditions
 */
async function getNextPrioritizedKeyword(): Promise<PrioritizedKeyword | null> {
  const existingSlugs = await fetchExistingArticleSlugs();
  // Merge existing slugs with in-progress slugs to avoid duplicates between workers
  const excludeSlugs = new Set([...existingSlugs, ...keywordsInProgress]);
  const nextKeyword = getNextKeyword(excludeSlugs);
  
  // ATOMIC: Lock the keyword immediately to prevent race conditions between workers
  if (nextKeyword) {
    keywordsInProgress.add(nextKeyword.slug);
  }
  
  return nextKeyword;
}

/**
 * Get generation queue status
 */
async function getGenerationQueueStatus(): Promise<{
  totalKeywords: number;
  generated: number;
  remaining: number;
  percentComplete: string;
  nextKeyword: PrioritizedKeyword | null;
  topPending: { high: number; medium: number; low: number };
}> {
  const existingSlugs = await fetchExistingArticleSlugs();
  const allKeywords = getPrioritizedKeywords();

  let highPending = 0, mediumPending = 0, lowPending = 0;

  for (const kw of allKeywords) {
    if (!existingSlugs.has(kw.slug)) {
      if (kw.priority === 'high') highPending++;
      else if (kw.priority === 'medium') mediumPending++;
      else lowPending++;
    }
  }

  const generated = existingSlugs.size;
  const remaining = allKeywords.length - generated;

  return {
    totalKeywords: allKeywords.length,
    generated,
    remaining,
    percentComplete: ((generated / allKeywords.length) * 100).toFixed(2),
    nextKeyword: getNextKeyword(existingSlugs),
    topPending: { high: highPending, medium: mediumPending, low: lowPending }
  };
}

/**
 * Direct CLI invocation using spawn with -p flag
 * This uses the official GitHub Copilot CLI directly (what the SDK wraps)
 * The SDK's session management has issues, but the CLI's -p flag works correctly
 */
async function generateWithCopilotCLI(prompt: string, timeout: number = 600000, maxRetries: number = 3): Promise<string> {
  const { execSync } = require('child_process');
  const fs = require('fs');

  // Get GitHub token from the correct config directory
  let ghToken: string;
  try {
    // Must exclude any existing GITHUB_TOKEN/GH_TOKEN env vars so gh CLI reads from config file
    const cleanEnv = { ...process.env };
    delete cleanEnv.GITHUB_TOKEN;
    delete cleanEnv.GH_TOKEN;
    delete cleanEnv.COPILOT_GITHUB_TOKEN;

    ghToken = execSync('gh auth token', {
      encoding: 'utf8',
      env: {
        ...cleanEnv,
        GH_CONFIG_DIR: '/home/runner/workspace/.config/gh',
        HOME: '/home/runner'
      }
    }).trim();
    console.log(`🔑 Got GitHub token (${ghToken.length} chars, starts with ${ghToken.substring(0, 4)})`);
  } catch (e) {
    throw new Error('GitHub auth required. Run: gh auth login');
  }

  // Transient errors that should trigger retry
  const retryableErrors = [
    'missing finish_reason',
    'ECONNRESET',
    'ETIMEDOUT',
    'socket hang up',
    'rate limit',
    'overloaded',
    '503',
    '502',
    '429'
  ];

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Write prompt to temp file to avoid shell escaping issues
    const promptFile = `/tmp/copilot-prompt-${Date.now()}.txt`;
    fs.writeFileSync(promptFile, prompt);
    console.log(`📝 Wrote prompt to ${promptFile} (attempt ${attempt}/${maxRetries})`);

    try {
      // Use wrapper script that takes token as first arg and prompt file as second
      const wrapperScript = '/home/runner/workspace/ghl-marketplace-app/scripts/run-copilot.sh';
      const cmd = `${wrapperScript} "${ghToken}" "${promptFile}" --model gpt-4.1 --allow-all-tools --no-ask-user`;

      console.log(`🚀 Executing Copilot CLI via wrapper (attempt ${attempt})...`);

      const result = execSync(cmd, {
        encoding: 'utf8',
        timeout: timeout,
        cwd: '/home/runner/workspace/ghl-marketplace-app',
        shell: '/bin/bash',
        maxBuffer: 50 * 1024 * 1024 // 50MB buffer for long responses
      });

      console.log(`✅ Got response (${result.length} chars)`);

      // Clean up and return success
      try { fs.unlinkSync(promptFile); } catch (e) {}
      return result;
    } catch (error: any) {
      // Clean up prompt file
      try { fs.unlinkSync(promptFile); } catch (e) {}

      // execSync throws on non-zero exit, capture stderr if available
      const output = error.stdout?.toString() || error.stderr?.toString() || error.message;
      console.error(`❌ CLI Error (attempt ${attempt}):`, output);

      // Check if error is retryable
      const isRetryable = retryableErrors.some(e => output.toLowerCase().includes(e.toLowerCase()));

      if (isRetryable && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // Exponential backoff, max 30s
        console.log(`🔄 Retryable error detected, waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        lastError = new Error(`Copilot CLI failed: ${output}`);
        continue;
      }

      throw new Error(`Copilot CLI failed: ${output}`);
    }
  }

  throw lastError || new Error('Copilot CLI failed after all retries');
}

/**
 * OpenRouter Free Model Generation
 * Uses verified free models - prioritizing NON-reasoning models for JSON output
 */
async function generateWithOpenRouter(prompt: string, timeout: number = 600000): Promise<string> {
  const apiKey = secrets.get('OPENROUTER_API_KEY');
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not found in Doppler secrets');
  }

  // Use verified AVAILABLE free models (from OpenRouter API Jan 2026)
  // Prioritizing non-reasoning models that output JSON cleanly
  const freeModels = [
    'meta-llama/llama-3.3-70b-instruct:free',     // Llama 3.3 70B - excellent for JSON
    'mistralai/mistral-small-3.1-24b-instruct:free', // Mistral Small 3.1 24B
    'google/gemma-3-27b-it:free',                  // Gemma 3 27B
    'openai/gpt-oss-20b:free',                     // OpenAI OSS 20B
    'qwen/qwen3-coder:free'                        // Qwen3 Coder - good for structured output
  ];
  
  let lastError: Error | null = null;
  
  for (const model of freeModels) {
    try {
      console.log(`🌐 [OpenRouter] Trying ${model}...`);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://catsluvus.com',
          'X-Title': 'CatsLuvUs SEO Generator'
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'user', content: prompt }
          ],
          max_tokens: 16000,
          temperature: 0.7
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`⚠️ [OpenRouter] ${model} failed: ${response.status} - ${errorText.substring(0, 200)}`);
        lastError = new Error(`OpenRouter ${model}: ${response.status}`);
        continue;
      }
      
      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content;
      
      if (!content) {
        console.log(`⚠️ [OpenRouter] ${model} returned empty content`);
        lastError = new Error(`OpenRouter ${model}: empty response`);
        continue;
      }
      
      // Strip reasoning tokens from models like DeepSeek-R1 that output <think>...</think>
      let cleanContent = content;
      if (content.includes('<think>')) {
        cleanContent = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        console.log(`🧠 [OpenRouter] Stripped reasoning tokens (${content.length} -> ${cleanContent.length} chars)`);
      }
      
      console.log(`✅ [OpenRouter] Got response from ${model} (${cleanContent.length} chars)`);
      return cleanContent;
      
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log(`⚠️ [OpenRouter] ${model} timed out`);
        lastError = new Error(`OpenRouter ${model}: timeout`);
      } else {
        console.log(`⚠️ [OpenRouter] ${model} error: ${error.message}`);
        lastError = error;
      }
      continue;
    }
  }
  
  throw lastError || new Error('All OpenRouter free models failed');
}

// Track which worker generated each article for A/B comparison
let workerStats = {
  copilot: { count: 0, totalScore: 0, avgScore: 0 },
  cloudflare: { count: 0, totalScore: 0, avgScore: 0 }
};

function updateWorkerStats(worker: 'copilot' | 'cloudflare', seoScore: number) {
  workerStats[worker].count++;
  workerStats[worker].totalScore += seoScore;
  workerStats[worker].avgScore = Math.round(workerStats[worker].totalScore / workerStats[worker].count);
}

// For backward compatibility - spawn-based version (kept for reference)
async function generateWithCopilotCLISpawn(prompt: string, timeout: number = 600000): Promise<string> {
  const { spawn, execSync } = require('child_process');

  // Get GitHub token from the correct config directory
  let ghToken: string;
  try {
    // Must exclude any existing GITHUB_TOKEN/GH_TOKEN env vars so gh CLI reads from config file
    const cleanEnv = { ...process.env };
    delete cleanEnv.GITHUB_TOKEN;
    delete cleanEnv.GH_TOKEN;
    delete cleanEnv.COPILOT_GITHUB_TOKEN;

    ghToken = execSync('gh auth token', {
      encoding: 'utf8',
      env: {
        ...cleanEnv,
        GH_CONFIG_DIR: '/home/runner/workspace/.config/gh',
        HOME: '/home/runner'
      }
    }).trim();
    console.log(`🔑 Got GitHub token (${ghToken.length} chars, starts with ${ghToken.substring(0, 4)})`);
  } catch (e) {
    throw new Error('GitHub auth required. Run: gh auth login');
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cli.kill('SIGKILL');
      reject(new Error(`CLI timeout after ${timeout}ms`));
    }, timeout);

    // Spawn with proper environment - all env vars must be in env object
    const cli = spawn('npx', [
      'copilot',
      '-p', prompt,
      '--model', 'gpt-4.1',
      '--allow-all-tools',
      '--no-ask-user'
    ], {
      shell: false,
      env: {
        // Include PATH and other essentials
        PATH: process.env.PATH,
        HOME: '/home/runner',
        USER: 'runner',
        // GitHub authentication
        GH_TOKEN: ghToken,
        GITHUB_TOKEN: ghToken,
        COPILOT_GITHUB_TOKEN: ghToken,
        // Use the WORKSPACE config dir where gh is actually authenticated
        GH_CONFIG_DIR: '/home/runner/workspace/.config/gh',
        XDG_CONFIG_HOME: '/home/runner/workspace/.config',
        // Node related
        NODE_PATH: process.env.NODE_PATH,
        npm_config_prefix: process.env.npm_config_prefix
      },
      cwd: '/home/runner/workspace/ghl-marketplace-app'
    });

    let stdout = '';
    let stderr = '';

    cli.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    cli.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    cli.on('close', (code: number) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`CLI exited with code ${code}: ${stderr}`));
      }
    });

    cli.on('error', (err: Error) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

/**
 * SEO Article Generator API Routes
 * Uses OpenRouter API for AI-powered content generation
 * Deploys generated articles to Cloudflare KV for live serving
 * Routes namespaced under /api/seo-generator/*
 */

interface ArticleData {
  title: string;
  metaDescription: string;
  quickAnswer?: string;
  keyTakeaways?: string[];
  introduction: string;
  sections: Array<{ heading: string; content: string; subsections?: Array<{ heading: string; content: string }> }>;
  faqs: Array<{ question: string; answer: string }>;
  comparisonTable?: { headers: string[]; rows: string[][] };
  conclusion: string;
  wordCount: number;
  images?: Array<{ url: string; alt: string; caption: string }>;
  externalLinks?: Array<{ url: string; text: string; context: string }>;
  internalLinks?: Array<{ url?: string; slug?: string; anchorText: string; context: string }>;
  providerProsCons?: Array<{ provider: string; pros: string[]; cons: string[] }>;
}

/**
 * Build full HTML page from article data - Universal Template with GTM, AdSense, Hamburger Menu
 * Matches petinsurance main page best practices
 * Now supports dynamic category context for V3 categories
 */
function buildArticleHtml(article: ArticleData, slug: string, keyword: string, video?: YouTubeVideo, categoryContext?: CategoryContext | null): string {
  const year = new Date().getFullYear();
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  
  // Dynamic category values with fallbacks for V1 petinsurance compatibility
  const categoryName = categoryContext?.categoryName || 'Pet Insurance';
  const categoryBasePath = categoryContext?.basePath || '/petinsurance';
  const categoryDomain = categoryContext?.domain || 'catsluvus.com';
  const pageUrl = `https://${categoryDomain}${categoryBasePath}/${slug}`;

  // Extract category slug for internal linking (remove leading slash)
  const categoryForLinking = categoryBasePath.replace(/^\//, '') || 'petinsurance';

  // Get EEAT author for this topic
  const author = getAuthorForTopic(article.title);

  // Build sections HTML with internal linking
  const sectionsHtml = article.sections?.map((section, i) => {
    const linkedContent = autoLink(section.content, slug, categoryForLinking);
    let html = `<h2 id="section-${i}">${section.heading}</h2>\n<p>${linkedContent}</p>\n`;
    if (section.subsections) {
      section.subsections.forEach(sub => {
        const linkedSubContent = autoLink(sub.content, slug, categoryForLinking);
        html += `<h3>${sub.heading}</h3>\n<p>${linkedSubContent}</p>\n`;
      });
    }
    return html;
  }).join('\n') || '';

  // Apply internal linking to introduction and conclusion
  const linkedIntro = autoLink(article.introduction, slug, categoryForLinking);
  const linkedConclusion = autoLink(article.conclusion, slug, categoryForLinking);

  // Build comparison table with semantic markup for Featured Snippets
  // Google prefers clean HTML tables with scope attributes for Featured Snippets
  let tableHtml = '';
  if (article.comparisonTable) {
    const headers = article.comparisonTable.headers;
    const rows = article.comparisonTable.rows;
    tableHtml = `<figure class="comparison-table-wrapper" role="group" aria-labelledby="comparison-caption-${slug.slice(0, 8)}">
<table class="comparison-table">
<caption id="comparison-caption-${slug.slice(0, 8)}">Pet Insurance Provider Comparison for ${keyword} - ${new Date().getFullYear()}</caption>
<thead>
<tr>${headers.map((h, i) => `<th scope="col"${i === 0 ? ' class="provider-col"' : ''}>${h}</th>`).join('')}</tr>
</thead>
<tbody>
${rows.map((row) => `<tr>
<th scope="row" class="provider-name">${row[0]}</th>
${row.slice(1).map((cell) => `<td>${cell}</td>`).join('')}
</tr>`).join('\n')}
</tbody>
</table>
<figcaption class="table-source">Data compiled from official provider websites. Prices may vary by location, pet age, and breed. Last updated: ${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}.</figcaption>
</figure>`;
  }

  // Build FAQ HTML
  const faqsHtml = article.faqs?.map(faq =>
    `<div class="faq-item"><h3>${faq.question}</h3><p>${faq.answer}</p></div>`
  ).join('\n') || '';

  // Build external authority links section
  const externalLinksHtml = article.externalLinks && article.externalLinks.length > 0 ? `
<div class="sources-section" id="sources">
<h2>Sources & References</h2>
<ul class="sources-list">
${article.externalLinks.map(link => 
  `<li><a href="${link.url}" target="_blank" rel="noopener">${link.text}</a> - ${link.context}</li>`
).join('\n')}
</ul>
</div>` : '';

  // Build internal links (Related Articles) section
  const internalLinksHtml = article.internalLinks && article.internalLinks.length > 0 ? `
<div class="related-articles" id="related">
<h2>Related Articles</h2>
<ul class="related-list">
${article.internalLinks.map(link => {
  // Support both new URL format and legacy slug format
  const href = link.url || `${categoryBasePath}/${link.slug}`;
  return `<li><a href="${href}">${link.anchorText}</a> - ${link.context}</li>`;
}).join('\n')}
</ul>
</div>` : '';

  // Build Pros & Cons section for Google rich results
  const prosConsHtml = article.providerProsCons && article.providerProsCons.length > 0 ? `
<section class="pros-cons-section" id="pros-cons">
<h2>Provider Pros & Cons</h2>
<p class="pros-cons-intro">Our expert analysis of each pet insurance provider to help you make an informed decision:</p>
<div class="pros-cons-grid">
${article.providerProsCons.map(provider => `
<div class="pros-cons-card">
<h3>${provider.provider}</h3>
<div class="pros">
<h4><span class="icon-pros">✓</span> Pros</h4>
<ul>
${provider.pros.map(pro => `<li>${pro}</li>`).join('\n')}
</ul>
</div>
<div class="cons">
<h4><span class="icon-cons">✗</span> Cons</h4>
<ul>
${provider.cons.map(con => `<li>${con}</li>`).join('\n')}
</ul>
</div>
</div>`).join('\n')}
</div>
</section>` : '';

  // Build TOC
  const tocHtml = article.sections?.map((s, i) =>
    `<li><a href="#section-${i}">${s.heading}</a></li>`
  ).join('\n') || '';

  // Enhanced Schema.org structured data following Google Search Console best practices
  // pageUrl is defined at the top of the function using dynamic category context
  // Use full ISO 8601 format with timezone for Google Rich Results compliance
  const publishDate = new Date().toISOString(); // e.g., "2026-01-29T19:00:00.000Z"
  const wordCount = article.wordCount || 3500;

  // WebSite schema for sitelinks search box
  const websiteSchema = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": "https://catsluvus.com/#website",
    "url": "https://catsluvus.com",
    "name": "Cats Luv Us",
    "description": "Expert pet insurance comparisons, reviews, and guides",
    "publisher": { "@id": "https://catsluvus.com/#organization" },
    "potentialAction": {
      "@type": "SearchAction",
      "target": {
        "@type": "EntryPoint",
        "urlTemplate": "https://catsluvus.com/petinsurance/?s={search_term_string}"
      },
      "query-input": "required name=search_term_string"
    }
  };

  // Organization schema with enhanced details
  const organizationSchema = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": "https://catsluvus.com/#organization",
    "name": "Cats Luv Us",
    "url": "https://www.catsluvus.com",
    "logo": {
      "@type": "ImageObject",
      "@id": "https://catsluvus.com/#logo",
      "url": "https://www.catsluvus.com/wp-content/uploads/2024/05/Group-3.png",
      "contentUrl": "https://www.catsluvus.com/wp-content/uploads/2024/05/Group-3.png",
      "width": 512,
      "height": 512,
      "caption": "Cats Luv Us Logo"
    },
    "sameAs": [
      "https://www.facebook.com/catsluvusboardinghotel",
      "https://www.instagram.com/catsluvusboardinghotel"
    ],
    "contactPoint": {
      "@type": "ContactPoint",
      "telephone": "+1-972-438-2868",
      "contactType": "customer service",
      "areaServed": "US",
      "availableLanguage": "English"
    }
  };

  // Article schema with all recommended properties for Google
  const articleSchema = {
    "@context": "https://schema.org",
    "@type": "Article",
    "@id": `${pageUrl}#article`,
    "isPartOf": { "@id": `${pageUrl}#webpage` },
    "headline": article.title,
    "description": article.metaDescription,
    "datePublished": publishDate,
    "dateModified": publishDate,
    "wordCount": wordCount,
    "inLanguage": "en-US",
    "mainEntityOfPage": { "@id": `${pageUrl}#webpage` },
    "author": {
      "@type": "Person",
      "@id": `https://catsluvus.com/author/${author.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}#author`,
      "name": author.name,
      "description": author.bio,
      "jobTitle": author.credentials,
      "url": `https://catsluvus.com/about#${author.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      "worksFor": { "@id": "https://catsluvus.com/#organization" }
    },
    "publisher": { "@id": "https://catsluvus.com/#organization" },
    "image": [
      {
        "@type": "ImageObject",
        "@id": `${pageUrl}#primaryimage`,
        "url": article.images?.[0]?.url || "https://www.catsluvus.com/wp-content/uploads/2024/05/Group-3.png",
        "contentUrl": article.images?.[0]?.url || "https://www.catsluvus.com/wp-content/uploads/2024/05/Group-3.png",
        "width": 1200,
        "height": 675,
        "caption": article.images?.[0]?.caption || article.title
      },
      {
        "@type": "ImageObject",
        "url": article.images?.[1]?.url || "https://www.catsluvus.com/wp-content/uploads/2024/05/Group-3.png",
        "width": 1200,
        "height": 900
      },
      {
        "@type": "ImageObject",
        "url": article.images?.[2]?.url || "https://www.catsluvus.com/wp-content/uploads/2024/05/Group-3.png",
        "width": 1200,
        "height": 1200
      }
    ],
    "thumbnailUrl": article.images?.[0]?.url || "https://www.catsluvus.com/wp-content/uploads/2024/05/Group-3.png",
    "keywords": [keyword, "pet insurance", "pet coverage", "insurance comparison"].join(", "),
    "articleSection": keyword.includes('dog') ? "Dog Insurance" : keyword.includes('cat') ? "Cat Insurance" : "Pet Insurance",
    "speakable": {
      "@type": "SpeakableSpecification",
      "cssSelector": [".article-intro", "h1", ".key-takeaways"]
    },
    "about": {
      "@type": "Thing",
      "name": "Pet Insurance",
      "description": "Insurance policies that cover veterinary costs for pets"
    },
    ...(article.providerProsCons && article.providerProsCons.length > 0 ? {
      "positiveNotes": {
        "@type": "ItemList",
        "itemListElement": article.providerProsCons.flatMap(p => p.pros).slice(0, 5).map((pro, i) => ({
          "@type": "ListItem",
          "position": i + 1,
          "name": pro
        }))
      },
      "negativeNotes": {
        "@type": "ItemList",
        "itemListElement": article.providerProsCons.flatMap(p => p.cons).slice(0, 5).map((con, i) => ({
          "@type": "ListItem",
          "position": i + 1,
          "name": con
        }))
      }
    } : {})
  };

  // WebPage schema linking everything together
  const webPageSchema = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${pageUrl}#webpage`,
    "url": pageUrl,
    "name": article.title,
    "description": article.metaDescription,
    "isPartOf": { "@id": "https://catsluvus.com/#website" },
    "primaryImageOfPage": { "@id": `${pageUrl}#primaryimage` },
    "datePublished": publishDate,
    "dateModified": publishDate,
    "breadcrumb": { "@id": `${pageUrl}#breadcrumb` },
    "inLanguage": "en-US",
    "potentialAction": [{
      "@type": "ReadAction",
      "target": [pageUrl]
    }]
  };

  // FAQ schema with proper linking
  const faqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${pageUrl}#faq`,
    "isPartOf": { "@id": `${pageUrl}#webpage` },
    "mainEntity": article.faqs?.map((faq, index) => ({
      "@type": "Question",
      "@id": `${pageUrl}#faq-${index + 1}`,
      "name": faq.question,
      "acceptedAnswer": {
        "@type": "Answer",
        "text": faq.answer
      }
    })) || []
  };

  // BreadcrumbList schema with proper @id - uses dynamic category context
  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "@id": `${pageUrl}#breadcrumb`,
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Home", "item": `https://${categoryDomain}` },
      { "@type": "ListItem", "position": 2, "name": categoryName, "item": `https://${categoryDomain}${categoryBasePath}` },
      { "@type": "ListItem", "position": 3, "name": article.title, "item": pageUrl }
    ]
  };

  // Combined graph for better entity relationships
  // ItemList schema for comparison table (helps with Featured Snippets for "best X" queries)
  // Uses Service type instead of Product with fake pricing for better schema accuracy
  const comparisonListSchema = article.comparisonTable && article.comparisonTable.rows.length > 0 ? {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${pageUrl}#comparison-list`,
    "name": `Best Pet Insurance Providers for ${keyword}`,
    "description": `Comparison of top pet insurance providers including pricing, coverage, and reimbursement rates for ${keyword}`,
    "numberOfItems": article.comparisonTable.rows.length,
    "itemListElement": article.comparisonTable.rows.map((row, index) => ({
      "@type": "ListItem",
      "position": index + 1,
      "name": row[0],
      "item": {
        "@type": "Service",
        "name": `${row[0]} Pet Insurance`,
        "provider": { "@type": "Organization", "name": row[0] },
        "serviceType": "Pet Insurance",
        "areaServed": "US"
      }
    }))
  } : null;

  // VideoObject schema for embedded YouTube video
  const videoSchema = video ? {
    "@context": "https://schema.org",
    "@type": "VideoObject",
    "@id": `${pageUrl}#video`,
    "name": video.title,
    "description": video.description,
    "thumbnailUrl": [
      video.thumbnailUrl,
      `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`,
      `https://img.youtube.com/vi/${video.videoId}/mqdefault.jpg`
    ],
    "uploadDate": video.publishedISO || new Date().toISOString().split('T')[0],
    "duration": video.durationISO,
    "contentUrl": video.watchUrl,
    "embedUrl": video.embedUrl,
    "publisher": {
      "@type": "Organization",
      "name": video.channel,
      "url": "https://www.youtube.com"
    },
    "inLanguage": "en-US",
    "interactionStatistic": {
      "@type": "InteractionCounter",
      "interactionType": { "@type": "WatchAction" },
      "userInteractionCount": video.viewCount || 0
    }
  } : null;

  const schemaGraph = {
    "@context": "https://schema.org",
    "@graph": [
      websiteSchema,
      organizationSchema,
      webPageSchema,
      articleSchema,
      breadcrumbSchema,
      ...(article.faqs && article.faqs.length > 0 ? [faqSchema] : []),
      ...(comparisonListSchema ? [comparisonListSchema] : []),
      ...(videoSchema ? [videoSchema] : [])
    ]
  };

  // NOTE: Navigation menu items now handled by Worker HTMLRewriter injection

  return `<!DOCTYPE html>
<html lang="en">
<head>
<!-- Google AdSense -->
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9364522191686432" crossorigin="anonymous"></script>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${article.title}</title>
<meta name="description" content="${article.metaDescription}">
<meta name="keywords" content="${keyword}, pet insurance, ${keyword.includes('dog') ? 'dog insurance' : keyword.includes('cat') ? 'cat insurance' : 'pet coverage'}">
<link rel="canonical" href="${pageUrl}">

<!-- Open Graph -->
<meta property="og:type" content="article">
<meta property="og:url" content="${pageUrl}">
<meta property="og:title" content="${article.title}">
<meta property="og:description" content="${article.metaDescription}">
<meta property="og:image" content="${article.images?.[0]?.url || 'https://www.catsluvus.com/wp-content/uploads/2024/05/Group-3.png'}">
<meta property="og:image:alt" content="${article.images?.[0]?.alt || article.title}">

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:url" content="${pageUrl}">
<meta name="twitter:title" content="${article.title}">
<meta name="twitter:description" content="${article.metaDescription}">
<meta name="twitter:image" content="${article.images?.[0]?.url || 'https://www.catsluvus.com/wp-content/uploads/2024/05/Group-3.png'}">
<meta name="twitter:image:alt" content="${article.images?.[0]?.alt || article.title}">

<!-- Structured Data (Google Search Console optimized @graph format) -->
<script type="application/ld+json">${JSON.stringify(schemaGraph)}</script>

<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','GTM-KPSXGQWC');</script>

<style>
/* CSS Custom Properties */
:root {
  --wc-color-primary: #326891;
  --wc-color-primary-dark: #265073;
  --wc-color-text: #121212;
  --wc-color-text-secondary: #555555;
  --wc-color-border: #e2e2e2;
  --wc-color-bg: #ffffff;
  --wc-color-bg-hover: #f8f8f8;
  --wc-transition-speed: 300ms;
}

/* Reset & Base */
*{box-sizing:border-box;margin:0;padding:0}
html,body{overflow-x:hidden;width:100%;max-width:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;line-height:1.8;color:var(--wc-color-text);background:var(--wc-color-bg)}

/* Skip Link for Accessibility */
.skip-link{position:absolute;top:-40px;left:0;background:#333;color:#fff;padding:8px 16px;text-decoration:none;border-radius:0 0 4px 0;z-index:99999}
.skip-link:focus{top:0}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* NOTE: Navigation chrome (hamburger, nav menu, footer) injected by Worker HTMLRewriter */

/* Main Content - SEO Best Practices for Readability */
main{padding-top:70px;overflow-x:hidden}
.container{max-width:720px;margin:0 auto;padding:40px 24px;overflow-wrap:break-word;word-wrap:break-word;overflow-x:hidden}

/* Typography - Optimized for readability (45-75 chars per line) */
body{font-size:18px;line-height:1.75;letter-spacing:-0.01em}
article{font-size:18px;line-height:1.8;color:#1a1a1a;overflow-wrap:break-word;word-wrap:break-word}
article p{margin-bottom:1.5em;text-align:left;word-spacing:0.05em;overflow-wrap:break-word;hyphens:auto;-webkit-hyphens:auto}
h1{font-size:2rem;margin-bottom:20px;color:var(--wc-color-primary);line-height:1.3;letter-spacing:-0.02em}
h2{font-size:1.4rem;margin:48px 0 24px;border-bottom:2px solid var(--wc-color-border);padding-bottom:12px;line-height:1.4}
h3{font-size:1.15rem;margin:32px 0 16px;line-height:1.4}
p{margin-bottom:1.25em;overflow-wrap:break-word;hyphens:auto;-webkit-hyphens:auto}
ul,ol{margin:1.25em 0 1.5em 1.5em;line-height:1.7}
li{margin-bottom:0.5em;overflow-wrap:break-word}
a{color:var(--wc-color-primary)}

/* Prevent content overflow - Critical for readability */
article img,article video,article iframe,article embed,article object{max-width:100%;height:auto;display:block}
article pre,article code{overflow-x:auto;max-width:100%;white-space:pre-wrap;word-wrap:break-word}
a{overflow-wrap:break-word;word-break:break-all}
article *{max-width:100%}

/* Breadcrumb */
.breadcrumb{font-size:14px;margin-bottom:20px;padding-top:10px}
.breadcrumb a{color:var(--wc-color-primary);text-decoration:none}

/* Article Introduction - Speakable content */
.article-intro{font-size:1.15em;line-height:1.8;color:#333;margin-bottom:2em}
.article-intro p:first-of-type{font-weight:500}

/* Article Images */
.article-image{margin:30px 0;text-align:center}
.article-image img{max-width:100%;height:auto;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.1)}
.article-image figcaption{font-size:14px;color:#666;margin-top:10px;font-style:italic}

/* Author Box */
.author-box{display:flex;gap:16px;padding:20px;background:#f8f9fa;border-radius:8px;margin:24px 0;border-left:4px solid var(--wc-color-primary)}
.author-box img{width:80px;height:80px;border-radius:50%;object-fit:cover;flex-shrink:0}
.author-info h4{margin:0 0 4px;color:var(--wc-color-primary)}
.author-info .credentials{font-size:14px;color:#666;margin-bottom:8px}
.author-info .bio{font-size:15px;line-height:1.6}

/* Table of Contents */
.toc{background:linear-gradient(135deg,#f8f9fa,#e9ecef);padding:24px 28px;border-radius:12px;margin:30px 0;border:1px solid #dee2e6;box-shadow:0 2px 8px rgba(0,0,0,0.05)}
.toc-title{font-size:1.1rem;color:var(--wc-color-primary);margin:0 0 16px 0;padding-bottom:12px;border-bottom:2px solid var(--wc-color-primary)}
.toc-list{list-style:none;margin:0;padding:0;counter-reset:toc-counter}
.toc-list li{margin:0;padding:10px 0;border-bottom:1px solid rgba(0,0,0,0.08);counter-increment:toc-counter}
.toc-list li:last-child{border-bottom:none}
.toc-list li::before{content:counter(toc-counter) ".";color:var(--wc-color-primary);font-weight:700;margin-right:10px}
.toc-list a{color:#333;text-decoration:none;font-weight:500;transition:color 0.2s}
.toc-list a:hover{color:var(--wc-color-primary);text-decoration:underline}

/* Quick Answer Box - Featured Snippet Optimization (Position 0) */
.quick-answer{background:#fff3cd;border:2px solid #ffc107;border-radius:8px;padding:20px 25px;margin:20px 0 30px 0;font-size:1.1em;line-height:1.7}
.quick-answer strong{color:#856404;display:block;margin-bottom:8px;font-size:0.95em;text-transform:uppercase;letter-spacing:0.5px}

/* Key Takeaways (speakable content) */
.key-takeaways{background:linear-gradient(135deg,#e8f4f8 0%,#d4e8ed 100%);border-left:4px solid var(--wc-color-primary);padding:20px 25px;border-radius:0 8px 8px 0;margin:30px 0}
.key-takeaways h2{font-size:1.2rem;margin:0 0 15px 0;color:var(--wc-color-primary)}
.key-takeaways ul{margin:0;padding-left:20px}
.key-takeaways li{margin:8px 0;line-height:1.6}

/* Tables - Responsive with horizontal scroll */
.table-wrapper{overflow-x:auto;margin:20px 0;-webkit-overflow-scrolling:touch;max-width:100%}
table{width:100%;border-collapse:collapse;min-width:500px;table-layout:fixed}
th,td{padding:12px;border:1px solid var(--wc-color-border);text-align:left;overflow-wrap:break-word;word-wrap:break-word}
th{background:#f8f8f8;font-weight:600}
td{max-width:200px}
/* Enhanced Comparison Table for Featured Snippets */
.comparison-table-wrapper{margin:30px 0;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08);overflow:hidden}
.comparison-table{min-width:100%;margin:0;border:none;border-radius:0}
.comparison-table caption{padding:16px 20px;background:linear-gradient(135deg,var(--wc-color-primary) 0%,var(--wc-color-primary-dark) 100%);color:#fff;font-weight:600;font-size:1.1rem;text-align:left}
.comparison-table thead th{background:#f8fafc;color:var(--wc-color-text);font-weight:700;padding:14px 16px;border-bottom:2px solid var(--wc-color-primary)}
.comparison-table .provider-col{width:140px}
.comparison-table .provider-name{background:#f8fafc;font-weight:600;color:var(--wc-color-primary)}
.comparison-table tbody tr:nth-child(even){background:#fafbfc}
.comparison-table tbody tr:hover{background:#e8f4f8}
.table-source{padding:12px 20px;background:#f8fafc;font-size:0.85rem;color:#666;border-top:1px solid var(--wc-color-border);font-style:italic}

/* FAQ Section */
.faq{background:#f8f8f8;padding:24px;border-radius:8px;margin:40px 0}
.faq-item{margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid var(--wc-color-border)}
.faq-item:last-child{margin-bottom:0;padding-bottom:0;border-bottom:none}
.faq-item h3{color:var(--wc-color-primary);margin-bottom:8px}

/* Sources Section */
.sources-section{background:#f0f7ff;padding:24px;border-radius:8px;margin:40px 0;border-left:4px solid var(--wc-color-primary)}
.sources-section h2{color:var(--wc-color-primary);margin-bottom:16px}
.sources-list{list-style:none;padding:0;margin:0}
.sources-list li{padding:12px 0;border-bottom:1px solid rgba(0,0,0,0.1)}
.sources-list li:last-child{border-bottom:none}
.sources-list a{color:var(--wc-color-primary);font-weight:600;text-decoration:none}
.sources-list a:hover{text-decoration:underline}

/* Related Articles Section */
.related-articles{background:#f5fff5;padding:24px;border-radius:8px;margin:40px 0;border-left:4px solid #28a745}
.related-articles h2{color:#28a745;margin-bottom:16px}
.related-list{list-style:none;padding:0;margin:0}
.related-list li{padding:12px 0;border-bottom:1px solid rgba(0,0,0,0.1)}
.related-list li:last-child{border-bottom:none}
.related-list a{color:#28a745;font-weight:600;text-decoration:none}
.related-list a:hover{text-decoration:underline}

/* Video Hero Section - Prominent placement for Google Video indexing */
.video-hero{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:24px;border-radius:12px;margin:20px 0 32px;box-shadow:0 8px 32px rgba(0,0,0,0.15)}
.video-hero-title{color:#fff;font-size:1.1rem;margin:0 0 16px;font-weight:600;display:flex;align-items:center;gap:8px}
.video-hero-title::before{content:'▶';color:#ff6b35;font-size:0.9rem}
.video-hero .video-container{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,0,0,0.3)}
.video-hero .video-container iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:none;border-radius:8px}
.video-hero-meta{color:#b8b8b8;font-size:14px;margin:0;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.video-hero-meta strong{color:#fff}
.video-hero-cta{color:#ff6b35;font-size:13px;margin-top:12px;font-style:italic}

/* Legacy Video Section - YouTube Embed (fallback) */
.video-section{background:#fff8f0;padding:24px;border-radius:8px;margin:40px 0;border-left:4px solid #ff6b35}
.video-section h2{color:#d44d00;margin-bottom:16px;font-size:1.3rem}
.video-container{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;max-width:100%;border-radius:8px;margin-bottom:12px}
.video-container iframe{position:absolute;top:0;left:0;width:100%;height:100%;border-radius:8px}
.video-meta{color:#666;font-size:14px;margin:0}

/* Pros & Cons Section - Google Rich Results optimized */
.pros-cons-section{margin:40px 0;padding:0}
.pros-cons-section h2{color:var(--wc-color-primary);margin-bottom:8px}
.pros-cons-intro{color:#666;margin-bottom:24px;font-size:15px}
.pros-cons-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px}
.pros-cons-card{background:#fff;border:1px solid #e2e2e2;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,0.06)}
.pros-cons-card h3{font-size:1.1rem;color:var(--wc-color-primary);margin:0 0 16px 0;padding-bottom:12px;border-bottom:2px solid var(--wc-color-primary)}
.pros-cons-card .pros,.pros-cons-card .cons{margin-bottom:16px}
.pros-cons-card .pros:last-child,.pros-cons-card .cons:last-child{margin-bottom:0}
.pros-cons-card h4{font-size:0.95rem;margin:0 0 10px 0;display:flex;align-items:center;gap:8px}
.pros-cons-card .pros h4{color:#28a745}
.pros-cons-card .cons h4{color:#dc3545}
.icon-pros{color:#28a745;font-weight:bold;font-size:1.1em}
.icon-cons{color:#dc3545;font-weight:bold;font-size:1.1em}
.pros-cons-card ul{list-style:none;padding:0;margin:0}
.pros-cons-card li{padding:8px 0 8px 24px;position:relative;font-size:15px;line-height:1.5;border-bottom:1px solid rgba(0,0,0,0.05)}
.pros-cons-card li:last-child{border-bottom:none}
.pros-cons-card .pros li::before{content:"✓";position:absolute;left:0;color:#28a745;font-weight:bold}
.pros-cons-card .cons li::before{content:"✗";position:absolute;left:0;color:#dc3545;font-weight:bold}

/* Conclusion */
.conclusion{background:linear-gradient(135deg,#326891,#265073);color:#fff;padding:24px;border-radius:8px;margin:40px 0}
.conclusion h2{color:#fff;border-bottom-color:rgba(255,255,255,0.3)}

/* Video Hero - Primary Content Section for Google Video Mode */
.video-hero{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:24px;border-radius:12px;margin:20px 0 32px;box-shadow:0 8px 32px rgba(0,0,0,0.15)}
.video-hero-title{color:#fff;font-size:1.1rem;margin:0 0 16px;font-weight:600;display:flex;align-items:center;gap:8px}
.video-hero-title::before{content:'▶';color:#ff6b35;font-size:0.9rem}
.video-hero .video-container{position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,0,0,0.3)}
.video-hero .video-container iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:none;border-radius:8px}
.video-hero-meta{color:#b8b8b8;font-size:14px;margin:0;display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.video-hero-meta strong{color:#fff}
.video-hero-cta{color:#ff6b35;font-size:13px;margin-top:12px;font-style:italic}

/* Disclaimer */
.disclaimer{background:#f8f9fa;padding:12px 20px;text-align:center;font-size:14px;border-bottom:1px solid #e5e5e5}
.disclaimer a{color:#d63384;text-decoration:none}

/* Footer */
.site-footer{background:#1a1a1a;color:#fff;padding:60px 20px 40px;margin-top:60px}
.footer-content{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:40px}
.footer-section h4{font-size:16px;margin-bottom:16px;color:#fff}
.footer-section ul{list-style:none;padding:0;margin:0}
.footer-section li{margin-bottom:8px}
.footer-section a{color:#aaa;text-decoration:none;font-size:14px}
.footer-section a:hover{color:#fff}
.footer-bottom{max-width:1200px;margin:40px auto 0;padding-top:20px;border-top:1px solid #333;text-align:center;color:#666;font-size:13px}
.footer-bottom a{color:#888;text-decoration:none;margin:0 12px}

/* Responsive - Mobile-first readability */
@media (max-width:768px){
  body{font-size:17px}
  article{font-size:17px;line-height:1.75}
  h1{font-size:1.6rem}
  h2{font-size:1.25rem;margin:36px 0 18px}
  h3{font-size:1.1rem}
  .container{padding:32px 20px}
  .author-box{flex-direction:column;text-align:center}
  .author-box img{margin:0 auto}
  .footer-content{grid-template-columns:1fr 1fr}
}
@media (max-width:480px){
  body{font-size:16px}
  article{font-size:16px;line-height:1.7}
  h1{font-size:1.4rem}
  .container{padding:24px 16px}
  .footer-content{grid-template-columns:1fr}
  .key-takeaways{padding:16px 18px}
  .faq{padding:18px}
  .conclusion{padding:18px}
}

/* Reduced Motion */
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:0.01ms !important;transition-duration:0.01ms !important}
}

/* Print - hide chrome elements injected by Worker */
@media print{
  .hamburger-menu,.nav-menu,.universal-footer,.skip-link{display:none !important}
  body{padding-top:0}
}
</style>
</head>
<body>
<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-KPSXGQWC" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>

<!-- NOTE: Navigation chrome (hamburger, nav, footer) injected by Worker HTMLRewriter -->

<!-- Disclaimer Banner -->
<div class="disclaimer">
  We independently review everything we recommend. When you buy through our links, we may earn a commission.
  <a href="https://catsluvus.com/affiliate-disclosure/">Learn more ›</a>
</div>

<main id="main-content">
<div class="container">
<nav class="breadcrumb" aria-label="Breadcrumb">
<a href="/">Home</a> › <a href="${categoryBasePath}">${categoryName}</a> › ${article.title}
</nav>
<article itemscope itemtype="https://schema.org/Article">
<h1 itemprop="headline">${article.title}</h1>

${video ? `
<section class="video-hero" id="video" itemprop="video" itemscope itemtype="https://schema.org/VideoObject">
<meta itemprop="name" content="${video.title.replace(/"/g, '&quot;')}">
<meta itemprop="description" content="Expert video guide covering ${keyword}. Watch for tips, advice, and essential information from ${video.channel}.">
<meta itemprop="thumbnailUrl" content="${video.thumbnailUrl || `https://img.youtube.com/vi/${video.videoId}/maxresdefault.jpg`}">
<meta itemprop="uploadDate" content="${video.publishedAt || new Date().toISOString().split('T')[0]}">
<meta itemprop="duration" content="${video.isoDuration || 'PT5M'}">
<meta itemprop="embedUrl" content="${video.embedUrl}">
<meta itemprop="contentUrl" content="https://www.youtube.com/watch?v=${video.videoId}">
<span itemprop="publisher" itemscope itemtype="https://schema.org/Organization">
  <meta itemprop="name" content="${video.channel}">
</span>
<p class="video-hero-title">Watch: Expert Guide on ${keyword}</p>
<div class="video-container">
<iframe 
  src="${video.embedUrl}?rel=0&modestbranding=1&autoplay=0" 
  title="${video.title}" 
  frameborder="0" 
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
  allowfullscreen
  loading="eager"
  width="560" 
  height="315">
</iframe>
</div>
<p class="video-hero-meta"><strong itemprop="author">${video.channel}</strong> • <span>${video.duration}</span> • <span itemprop="interactionStatistic" itemscope itemtype="https://schema.org/InteractionCounter"><meta itemprop="interactionType" content="https://schema.org/WatchAction"><span itemprop="userInteractionCount">${video.views}</span></span></p>
<p class="video-hero-cta">Continue reading below for our complete written guide with pricing, comparisons, and FAQs.</p>
</section>
` : ''}

<p><strong>Last Updated:</strong> <time datetime="${new Date().toISOString().split('T')[0]}">${dateStr}</time></p>

<div class="author-box" itemprop="author" itemscope itemtype="https://schema.org/Person">
<img src="${author.image}" alt="${author.name}" itemprop="image" loading="lazy">
<div class="author-info">
<h4 itemprop="name">${author.name}</h4>
<p class="credentials" itemprop="jobTitle">${author.credentials}</p>
<p class="bio" itemprop="description">${author.bio}</p>
</div>
</div>

<div class="quick-answer" itemprop="description">
<strong>Quick Answer:</strong> ${article.quickAnswer || `The ${keyword} options include Lemonade ($15-40/month), Healthy Paws, and Trupanion. Compare plans with 70-90% reimbursement, $100-500 deductibles, and coverage for accidents, illnesses, and preventive care.`}
</div>

<div class="key-takeaways">
<h2>Key Takeaways</h2>
<ul>
${article.keyTakeaways?.map((takeaway: string) => `<li>${takeaway}</li>`).join('\n') || `
<li>Compare top pet insurance providers to find the best coverage for your pet's needs</li>
<li>Consider factors like deductibles, reimbursement rates, and annual limits when choosing a plan</li>
<li>Most plans exclude pre-existing conditions, so enroll your pet while they're healthy</li>
<li>Waiting periods typically range from 2-14 days for accidents and 14-30 days for illnesses</li>
`}
</ul>
</div>

<div class="introduction article-intro" itemprop="articleBody">
${linkedIntro}
</div>

${article.images?.[0] ? `<figure class="article-image">
<img src="${article.images[0].url}" alt="${article.images[0].alt}" loading="lazy" width="800" height="533" style="width: 100%; height: auto; max-width: 100%;">
<figcaption>${article.images[0].caption}</figcaption>
</figure>` : ''}

<nav class="toc" aria-label="Table of contents" id="table-of-contents">
<h2 class="toc-title">In This Article</h2>
<ol class="toc-list">
${tocHtml}
${article.comparisonTable ? '<li><a href="#comparison">Provider Comparison</a></li>' : ''}
${article.providerProsCons && article.providerProsCons.length > 0 ? '<li><a href="#pros-cons">Provider Pros & Cons</a></li>' : ''}
<li><a href="#faq">Frequently Asked Questions</a></li>
${article.externalLinks && article.externalLinks.length > 0 ? '<li><a href="#sources">Sources & References</a></li>' : ''}
${article.internalLinks && article.internalLinks.length > 0 ? '<li><a href="#related">Related Articles</a></li>' : ''}
</ol>
</nav>

${sectionsHtml}

${article.comparisonTable ? `<h2 id="comparison">Provider Comparison</h2>\n<div class="table-wrapper">${tableHtml}</div>` : ''}

${prosConsHtml}

${article.images?.[1] ? `<figure class="article-image">
<img src="${article.images[1].url}" alt="${article.images[1].alt}" loading="lazy" width="800" height="533" style="width: 100%; height: auto; max-width: 100%;">
<figcaption>${article.images[1].caption}</figcaption>
</figure>` : ''}

<div class="faq" id="faq">
<h2>Frequently Asked Questions</h2>
${faqsHtml}
</div>

${externalLinksHtml}

${internalLinksHtml}

${video ? `
<section class="video-section" id="video">
<h2>Watch: ${video.title}</h2>
<div class="video-container">
<iframe 
  src="${video.embedUrl}?rel=0&modestbranding=1" 
  title="${video.title}" 
  frameborder="0" 
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
  allowfullscreen
  loading="lazy"
  width="560" 
  height="315">
</iframe>
</div>
<p class="video-meta">Video by <strong>${video.channel}</strong> • ${video.duration} • ${video.views}</p>
</section>
` : ''}

${article.images?.[2] ? `<figure class="article-image">
<img src="${article.images[2].url}" alt="${article.images[2].alt}" loading="lazy" width="800" height="533" style="width: 100%; height: auto; max-width: 100%;">
<figcaption>${article.images[2].caption}</figcaption>
</figure>` : ''}

<div class="conclusion">
<h2>Conclusion</h2>
${linkedConclusion}
</div>

</article>
</div>
</main>
<!-- NOTE: Footer and menu JS injected by Worker HTMLRewriter -->
</body>
</html>`;
}

/**
 * SEO Tools for Copilot SDK Agent (using JSON Schema for parameters)
 */
async function getSEOTools() {
  const { defineTool } = await loadCopilotSDK();

  return [
    defineTool('analyze_serp', {
      description: 'Analyze Google SERP for a keyword to understand competitor content and identify gaps',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'The keyword to analyze SERP for' }
        },
        required: ['keyword']
      },
      handler: async (args: { keyword: string }) => {
        const result = await analyzeSERP(args.keyword);
        return JSON.stringify(result, null, 2);
      }
    }),

    defineTool('get_keyword_data', {
      description: 'Get keyword data including related entities and SEO thresholds',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'The keyword to get data for' }
        },
        required: ['keyword']
      },
      handler: async (args: { keyword: string }) => {
        const lower = args.keyword.toLowerCase();
        const isDog = lower.includes('dog') || lower.includes('puppy');
        const isCat = lower.includes('cat') || lower.includes('kitten');

        return JSON.stringify({
          keyword: args.keyword,
          slug: keywordToSlug(args.keyword),
          entities: {
            base: ENTITIES.base,
            specific: isDog ? ENTITIES.dog : isCat ? ENTITIES.cat : []
          },
          thresholds: SEO_THRESHOLDS,
          credibleSources: Object.values(CREDIBLE_SOURCES)
        }, null, 2);
      }
    }),

    defineTool('get_expert_author', {
      description: 'Get an EEAT expert author for a topic',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The topic/title to get an author for' }
        },
        required: ['topic']
      },
      handler: async (args: { topic: string }) => {
        const author = getAuthorForTopic(args.topic);
        return JSON.stringify(author, null, 2);
      }
    }),

    defineTool('deploy_to_cloudflare', {
      description: 'Deploy article HTML to Cloudflare KV for live serving',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'URL slug for the article' },
          html: { type: 'string', description: 'Full HTML content to deploy' },
          category: { type: 'string', description: 'Category slug (e.g., "cat-dna-testing" or "petinsurance"). Defaults to "petinsurance".' }
        },
        required: ['slug', 'html']
      },
      handler: async (args: { slug: string; html: string; category?: string }) => {
        const category = args.category || 'petinsurance';
        const result = await deployToCloudflareKV(args.slug, args.html, category);
        return JSON.stringify({
          ...result,
          liveUrl: result.success ? `https://catsluvus.com/${category}/${args.slug}` : null
        });
      }
    }),

    defineTool('build_article_html', {
      description: 'Build full SEO-optimized HTML from article JSON data',
      parameters: {
        type: 'object',
        properties: {
          article: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              metaDescription: { type: 'string' },
              introduction: { type: 'string' },
              sections: { type: 'array' },
              faqs: { type: 'array' },
              comparisonTable: { type: 'object' },
              conclusion: { type: 'string' },
              wordCount: { type: 'number' }
            },
            required: ['title', 'metaDescription', 'introduction', 'sections', 'faqs', 'conclusion', 'wordCount']
          },
          slug: { type: 'string' },
          keyword: { type: 'string' }
        },
        required: ['article', 'slug', 'keyword']
      },
      handler: async (args: { article: ArticleData; slug: string; keyword: string }) => {
        const html = buildArticleHtml(args.article, args.slug, args.keyword, undefined, activeCategoryContext);
        return html.substring(0, 500) + '... [HTML built successfully, ' + html.length + ' chars]';
      }
    })
  ];
}

/**
 * Generate article using GitHub Copilot CLI directly
 * Uses npx copilot -p (official CLI prompt mode that actually works)
 */
async function generateWithCopilotSDK(keyword: string): Promise<{
  success: boolean;
  article?: ArticleData;
  slug?: string;
  deployed?: boolean;
  liveUrl?: string | null;
  serpAnalysis?: any;
  error?: string;
}> {
  const slug = keywordToSlug(keyword);

  try {
    console.log(`🤖 [Copilot CLI] Generating article for: "${keyword}"`);

    // SERP Analysis - Analyze what's ranking #1-10 to beat competitors
    console.log(`🔍 [SERP] Analyzing top 10 Google results for: "${keyword}"`);
    const serpAnalysis = await analyzeSERP(keyword);
    
    // Build SERP insights for the prompt with competitor headings, FAQs, and entities
    const competitorHeadingsText = serpAnalysis.competitorHeadings.length > 0
      ? `\nCompetitor H2/H3 headings (COVER ALL these topics): ${serpAnalysis.competitorHeadings.slice(0, 12).join(' | ')}`
      : '';
    const competitorFAQsText = serpAnalysis.competitorFAQs.length > 0
      ? `\nCompetitor FAQ questions (ANSWER ALL these): ${serpAnalysis.competitorFAQs.slice(0, 8).join(' | ')}`
      : '';
    const competitorEntitiesText = serpAnalysis.competitorEntities && serpAnalysis.competitorEntities.length > 0
      ? `\nKey entities/brands competitors mention (MUST REFERENCE): ${serpAnalysis.competitorEntities.slice(0, 10).join(', ')}`
      : '';

    const serpInsights = serpAnalysis.topResults.length > 0 
      ? `\n\nCOMPETITOR ANALYSIS (Based on scraping top 10 Google results):
Top-ranking titles: ${serpAnalysis.topResults.slice(0, 5).map(r => `"${r.title}"`).join(', ')}
Topics ALL competitors cover (MUST INCLUDE): ${serpAnalysis.commonTopics.join(', ')}${competitorHeadingsText}${competitorFAQsText}${competitorEntitiesText}
Content gaps to exploit (UNIQUE ANGLES to beat competitors): ${serpAnalysis.contentGaps.join(', ')}
Target word count: ${serpAnalysis.targetWordCount}+ words (competitors average ${serpAnalysis.avgWordCount} words)
Average competitor title length: ${Math.round(serpAnalysis.avgTitleLength)} characters

CRITICAL: Your article MUST cover every topic/heading listed above, answer every FAQ question, and reference key entities/brands competitors mention. This ensures comprehensive coverage that Google rewards with Position 1.\n`
      : `\n\nCOMPETITOR ANALYSIS:
Topics to cover: ${serpAnalysis.commonTopics.join(', ')}
Content gaps to exploit: ${serpAnalysis.contentGaps.join(', ')}
Target word count: ${serpAnalysis.targetWordCount}+ words\n`;

    // Fetch existing articles for internal linking
    const existingSlugs = await fetchExistingArticleSlugs();
    const existingArticlesList = Array.from(existingSlugs).slice(0, 100).join(', ');

    // Fetch real People Also Ask questions from Google (FREE)
    const paaQuestions = await fetchPAAQuestions(keyword);
    const paaQuestionsText = paaQuestions.length > 0 
      ? `\n\nPEOPLE ALSO ASK (Use these EXACT questions as your FAQs - they are real Google search queries):\n${paaQuestions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}\n`
      : '';

    const prompt = `You are an expert SEO content writer for pet insurance. Generate an SEO article about "${keyword}" optimized for Google Featured Snippets (Position 0).
${serpInsights}
${paaQuestionsText}
Requirements:
- 3000+ words comprehensive content
- Use "${keyword}" naturally 8-12 times throughout
- Include comparison table with real data for: Lemonade, Healthy Paws, Trupanion, ASPCA
- Include 8+ detailed FAQs with 150+ word answers (USE THE "PEOPLE ALSO ASK" QUESTIONS ABOVE if provided)
- Include expert quotes and real pricing data
- Write in an authoritative, trustworthy tone
- Include 3-5 external authority links naturally in the content (official insurance provider sites, veterinary associations like AVMA, state insurance regulators, or other relevant .gov/.org sources)

INTERNAL LINKING (Critical for SEO):
Add 3-5 internal links to related articles from our existing content. Select the most relevant slugs from this list:
${existingArticlesList}

Use descriptive anchor text (not "click here"). Insert links naturally within the content where they add value.

CRITICAL FOR RANKING #1 - Featured Snippet Optimization:
1. quickAnswer: A 40-60 word DIRECT answer that Google can extract for Position 0. Start with "The [keyword] is..." format.
2. keyTakeaways: 4-5 bullet points (each 15-25 words) that summarize the key information.
3. FAQs must have concise first sentences (under 50 words) that directly answer the question, then expand.
4. images: 3 relevant Unsplash stock photo URLs with SEO alt text and captions.
5. externalLinks: 3-5 authority links with full URLs to official sources relevant to the topic (insurance providers, veterinary organizations, government regulators).

STRICT SEO REQUIREMENTS FOR 100/100 SCORE (CRITICAL - COUNT CHARACTERS):
**TITLE: EXACTLY 50-55 CHARACTERS (not 56+, not 49-)**
- Count EVERY character including spaces before outputting
- Example: "Best Cat Insurance Plans 2026: Expert Buyer Guide" = 50 chars ✓
- Use shorter words: "vs" not "versus", "&" not "and"

**META DESCRIPTION: EXACTLY 145-155 CHARACTERS (not 156+, not 144-)**
- Count EVERY character before outputting
- Include primary keyword naturally once
- Include call-to-action (Discover, Compare, Learn)

**KEYWORD DENSITY: 1.0-1.5%** (For 3000 words = use keyword 30-45 times)
**HEADINGS: 4-8 unique H2s** - No duplicates, keyword in 2+ H2s
**LINKS: 3-5 internal + 2-3 external authority links**

AI WRITING DETECTION AVOIDANCE (CRITICAL FOR SEO - from marketing-psychology skill):
Avoid these patterns that trigger AI detection algorithms:
- NEVER use em dashes (—). Use commas, colons, or parentheses instead.
- AVOID verbs: delve, leverage, utilize, foster, bolster, underscore, unveil, navigate, streamline, enhance, endeavour, embark, unravel
- AVOID adjectives: robust, comprehensive, pivotal, crucial, vital, transformative, cutting-edge, groundbreaking, seamless, nuanced, holistic, innovative, multifaceted
- AVOID phrases: "In today's fast-paced world", "It's important to note", "Let's delve into", "That being said", "At its core", "In the realm of", "It goes without saying"
- AVOID filler words: absolutely, actually, basically, certainly, essentially, extremely, fundamentally, incredibly, naturally, obviously, significantly, truly, ultimately
- Use varied sentence lengths and natural conversational tone
- Include contractions (don't, can't, won't) for natural voice
- Start some sentences with "And" or "But" for human-like flow
- Write like a human expert, not an AI

Return ONLY valid JSON (no markdown code blocks, no explanation before/after):
{
  "title": "[MAX 55 CHARS - SHORTER IS BETTER] SEO title with '${keyword}'",
  "metaDescription": "[MAX 155 CHARS] Description with '${keyword}'",
  "quickAnswer": "40-60 word direct answer starting with 'The ${keyword}...' that Google can pull for Featured Snippet Position 0. Include the top recommendation and key facts.",
  "keyTakeaways": [
    "First key point in 15-25 words with specific data",
    "Second key point about costs or coverage",
    "Third key point about best provider",
    "Fourth key point about what to avoid",
    "Fifth key point with actionable advice"
  ],
  "images": [
    {"url": "https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800&q=80", "alt": "Dog at veterinarian for ${keyword}", "caption": "Understanding your pet insurance options is key to protecting your furry family member."},
    {"url": "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=800&q=80", "alt": "Cat receiving medical care for ${keyword}", "caption": "Quality pet insurance ensures your cat gets the care they need."},
    {"url": "https://images.unsplash.com/photo-1450778869180-41d0601e046e?w=800&q=80", "alt": "Happy pet owner with dog discussing ${keyword}", "caption": "The right insurance plan gives pet owners peace of mind."}
  ],
  "introduction": "400+ words introducing the topic, establishing expertise",
  "sections": [
    {"heading": "UNIQUE H2 heading about coverage basics (no duplicates)", "content": "500+ words of detailed content"},
    {"heading": "DIFFERENT H2 about cost analysis (must be unique)", "content": "500+ words"},
    {"heading": "DISTINCT H2 comparing providers (all headings unique)", "content": "500+ words"},
    {"heading": "SEPARATE H2 on claims process (no repeated text)", "content": "500+ words"}
  ],
  "comparisonTable": {
    "headers": ["Provider", "Monthly Cost", "Deductible", "Reimbursement", "Annual Limit"],
    "rows": [
      ["Lemonade", "$15-40", "$100-500", "70-90%", "$5k-100k"],
      ["Healthy Paws", "$20-50", "$100-500", "70-90%", "Unlimited"],
      ["Trupanion", "$30-70", "$0-1000", "90%", "Unlimited"],
      ["ASPCA", "$18-45", "$100-500", "70-90%", "$5k-10k"]
    ]
  },
  "faqs": [
    {"question": "What is the ${keyword}?", "answer": "Start with 1-sentence direct answer under 50 words, then expand to 150+ words with details"},
    {"question": "How much does ${keyword} cost?", "answer": "Start with specific price range, then 150+ word detailed breakdown"},
    {"question": "Which provider offers the ${keyword}?", "answer": "Name the top provider first, then 150+ word comparison"},
    {"question": "Is ${keyword} worth it?", "answer": "Start with Yes/No and why in 1 sentence, then 150+ word explanation"},
    {"question": "Claims process question?", "answer": "150+ word detailed answer"},
    {"question": "Provider comparison question?", "answer": "150+ word detailed answer"},
    {"question": "Waiting period question?", "answer": "150+ word detailed answer"},
    {"question": "Pre-existing conditions question?", "answer": "150+ word detailed answer"}
  ],
  "conclusion": "300+ words summarizing key points and call to action",
  "externalLinks": [
    {"url": "https://example-provider.com", "text": "anchor text", "context": "sentence where link appears naturally"},
    {"url": "https://example-authority.org", "text": "anchor text", "context": "sentence where link appears naturally"}
  ],
  "internalLinks": [
    {"url": "/category/related-article-slug", "anchorText": "descriptive anchor text", "context": "sentence where internal link should appear naturally in the content"}
  ],
  "providerProsCons": [
    {"provider": "Lemonade", "pros": ["Low monthly premiums starting at $15", "Fast AI-powered claims processing", "User-friendly mobile app"], "cons": ["Lower annual limits than competitors", "No wellness add-on available", "Limited coverage for older pets"]},
    {"provider": "Healthy Paws", "pros": ["Unlimited annual payouts", "No caps on claims", "Fast reimbursement"], "cons": ["Higher premiums for comprehensive coverage", "No wellness coverage option", "Premiums increase with age"]},
    {"provider": "Trupanion", "pros": ["90% reimbursement rate", "Direct vet payment option", "Covers hereditary conditions"], "cons": ["Higher monthly costs", "Only one reimbursement tier", "Longer waiting periods"]},
    {"provider": "ASPCA", "pros": ["Flexible deductible options", "Wellness add-ons available", "Good for preventive care"], "cons": ["Lower annual limits", "Customer service complaints", "Slower claims processing"]}
  ],
  "wordCount": 3500
}`;

    // Use direct CLI invocation (10 minute timeout for long articles)
    const content = await generateWithCopilotCLI(prompt, 600000);
    console.log(`🤖 [Copilot CLI] Received response (${content.length} chars)`);

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*"title"[\s\S]*"conclusion"[\s\S]*\}/);
    if (!jsonMatch) {
      console.log('⚠️ [Copilot CLI] No JSON found. Response preview:', content.substring(0, 500));
      throw new Error('No article JSON in Copilot response');
    }

    // Sanitize JSON: remove control characters that break parsing
    const sanitizedJson = jsonMatch[0]
      .replace(/[\x00-\x1F\x7F]/g, (char) => {
        // Preserve valid JSON whitespace: tab, newline, carriage return
        if (char === '\t' || char === '\n' || char === '\r') return char;
        // Remove other control characters
        return '';
      })
      .replace(/\n\s*\n/g, '\n'); // Collapse multiple newlines
    
    const article = JSON.parse(sanitizedJson) as ArticleData;
    console.log(`✅ [Copilot CLI] Generated: ${article.title}`);

    // Enforce SEO limits - truncate title and meta description
    const seoLimits = enforceSEOLimits(article);
    article.title = seoLimits.title;
    article.metaDescription = seoLimits.metaDescription;

    // Search for relevant YouTube video
    let video: YouTubeVideo | undefined;
    try {
      const videoResult = searchYouTubeVideo(keyword);
      if (videoResult.success && videoResult.videos && videoResult.videos.length > 0) {
        video = videoResult.videos[0];
        console.log(`🎬 [YouTube] Found video: "${video.title}" by ${video.channel}`);
      }
    } catch (err: any) {
      console.log(`⚠️ [YouTube] Search skipped: ${err.message}`);
    }

    // Build HTML and deploy to Cloudflare KV - pass activeCategoryContext for dynamic breadcrumbs/URLs
    const html = buildArticleHtml(article, slug, keyword, video, activeCategoryContext);
    
    // Calculate SEO score using seord library
    const seoScore = await calculateSEOScore(html, keyword, article.title, article.metaDescription);
    console.log(`📊 [SEO Score] ${slug}: ${seoScore.score}/100`);
    
    // Track worker stats
    updateWorkerStats('copilot', seoScore.score);
    
    const deployResult = await deployToCloudflareKV(slug, html);

    if (deployResult.success) {
      console.log(`☁️ [Copilot CLI] Deployed to KV: ${slug}`);
    }

    // Use dynamic category context for liveUrl
    const categoryPath = activeCategoryContext?.basePath || '/petinsurance';
    const categoryDomainForUrl = activeCategoryContext?.domain || 'catsluvus.com';
    
    return {
      success: true,
      article,
      slug,
      deployed: deployResult.success,
      liveUrl: deployResult.success ? `https://${categoryDomainForUrl}${categoryPath}/${slug}` : null,
      seoScore: seoScore.score,
      worker: 'copilot' as const,
      serpAnalysis: {
        competitorsAnalyzed: serpAnalysis.topResults.length,
        topicsFound: serpAnalysis.commonTopics,
        competitorHeadings: serpAnalysis.competitorHeadings.slice(0, 10),
        competitorFAQs: serpAnalysis.competitorFAQs.slice(0, 8),
        competitorEntities: serpAnalysis.competitorEntities?.slice(0, 10) || [],
        contentGaps: serpAnalysis.contentGaps,
        targetWordCount: serpAnalysis.targetWordCount,
        avgCompetitorWordCount: serpAnalysis.avgWordCount
      }
    } as any;

  } catch (error: any) {
    console.error(`❌ [Copilot CLI] Error:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Generate article using Cloudflare Workers AI
 * Same logic as generateWithCopilotSDK but uses Cloudflare AI (replaced unreliable OpenRouter FREE)
 * Includes AI writing detection avoidance rules from coreyhaines31/marketingskills
 */
async function generateWithCloudflareAI_SDK(keyword: string): Promise<{
  success: boolean;
  article?: ArticleData;
  slug?: string;
  deployed?: boolean;
  liveUrl?: string | null;
  serpAnalysis?: any;
  error?: string;
  worker?: 'cloudflare';
  model?: string;
}> {
  const slug = keywordToSlug(keyword);

  try {
    console.log(`☁️ [Cloudflare AI] Generating article for: "${keyword}"`);

    // SERP Analysis - Analyze what's ranking #1-10 to beat competitors
    console.log(`🔍 [SERP] Analyzing top 10 Google results for: "${keyword}"`);
    const serpAnalysis = await analyzeSERP(keyword);
    
    // Build SERP insights for the prompt with competitor headings, FAQs, and entities
    const competitorHeadingsText = serpAnalysis.competitorHeadings.length > 0
      ? `\nCompetitor H2/H3 headings (COVER ALL these topics): ${serpAnalysis.competitorHeadings.slice(0, 12).join(' | ')}`
      : '';
    const competitorFAQsText = serpAnalysis.competitorFAQs.length > 0
      ? `\nCompetitor FAQ questions (ANSWER ALL these): ${serpAnalysis.competitorFAQs.slice(0, 8).join(' | ')}`
      : '';
    const competitorEntitiesText = serpAnalysis.competitorEntities && serpAnalysis.competitorEntities.length > 0
      ? `\nKey entities/brands competitors mention (MUST REFERENCE): ${serpAnalysis.competitorEntities.slice(0, 10).join(', ')}`
      : '';

    const serpInsights = serpAnalysis.topResults.length > 0 
      ? `\n\nCOMPETITOR ANALYSIS (Based on scraping top 10 Google results):
Top-ranking titles: ${serpAnalysis.topResults.slice(0, 5).map(r => `"${r.title}"`).join(', ')}
Topics ALL competitors cover (MUST INCLUDE): ${serpAnalysis.commonTopics.join(', ')}${competitorHeadingsText}${competitorFAQsText}${competitorEntitiesText}
Content gaps to exploit (UNIQUE ANGLES to beat competitors): ${serpAnalysis.contentGaps.join(', ')}
Target word count: ${serpAnalysis.targetWordCount}+ words (competitors average ${serpAnalysis.avgWordCount} words)
Average competitor title length: ${Math.round(serpAnalysis.avgTitleLength)} characters

CRITICAL: Your article MUST cover every topic/heading listed above, answer every FAQ question, and reference key entities/brands competitors mention. This ensures comprehensive coverage that Google rewards with Position 1.\n`
      : `\n\nCOMPETITOR ANALYSIS:
Topics to cover: ${serpAnalysis.commonTopics.join(', ')}
Content gaps to exploit: ${serpAnalysis.contentGaps.join(', ')}
Target word count: ${serpAnalysis.targetWordCount}+ words\n`;

    // Fetch existing articles for internal linking
    const existingSlugs = await fetchExistingArticleSlugs();
    const existingArticlesList = Array.from(existingSlugs).slice(0, 100).join(', ');

    // Fetch real People Also Ask questions from Google (FREE)
    const paaQuestions = await fetchPAAQuestions(keyword);
    const paaQuestionsText = paaQuestions.length > 0 
      ? `\n\nPEOPLE ALSO ASK (Use these EXACT questions as your FAQs - they are real Google search queries):\n${paaQuestions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}\n`
      : '';

    const prompt = `You are an expert SEO content writer for pet insurance. Generate an SEO article about "${keyword}" optimized for Google Featured Snippets (Position 0).
${serpInsights}
${paaQuestionsText}
Requirements:
- 3000+ words comprehensive content
- Use "${keyword}" naturally 8-12 times throughout
- Include comparison table with real data for: Lemonade, Healthy Paws, Trupanion, ASPCA
- Include 8+ detailed FAQs with 150+ word answers (USE THE "PEOPLE ALSO ASK" QUESTIONS ABOVE if provided)
- Include expert quotes and real pricing data
- Write in an authoritative, trustworthy tone
- Include 3-5 external authority links naturally in the content

INTERNAL LINKING (Critical for SEO):
Add 3-5 internal links to related articles. Select the most relevant slugs from this list:
${existingArticlesList}

STRICT SEO REQUIREMENTS:
**TITLE LENGTH: MAXIMUM 55 CHARACTERS**
**META DESCRIPTION: MAXIMUM 155 CHARACTERS**
- All H2/H3 headings MUST be unique

AI WRITING DETECTION AVOIDANCE (CRITICAL FOR SEO):
Avoid these patterns that trigger AI detection algorithms:
- NEVER use em dashes (—). Use commas, colons, or parentheses instead.
- AVOID verbs: delve, leverage, utilize, foster, bolster, underscore, unveil, navigate, streamline, enhance, endeavour
- AVOID adjectives: robust, comprehensive, pivotal, crucial, vital, transformative, cutting-edge, groundbreaking, seamless, nuanced, holistic
- AVOID phrases: "In today's fast-paced world", "It's important to note", "Let's delve into", "That being said", "At its core", "In the realm of"
- AVOID filler words: absolutely, actually, basically, certainly, essentially, extremely, fundamentally, incredibly, naturally, obviously, significantly, truly, ultimately
- Use varied sentence lengths and natural conversational tone
- Write like a human expert, not an AI

Return ONLY valid JSON (no markdown code blocks):
{
  "title": "[MAX 55 CHARS] SEO title with '${keyword}'",
  "metaDescription": "[MAX 155 CHARS] Description with '${keyword}'",
  "quickAnswer": "40-60 word direct answer for Featured Snippet",
  "keyTakeaways": ["5 key points, 15-25 words each"],
  "images": [
    {"url": "https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800&q=80", "alt": "Dog at vet", "caption": "Pet insurance protects your furry family."},
    {"url": "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?w=800&q=80", "alt": "Cat care", "caption": "Quality care for your cat."},
    {"url": "https://images.unsplash.com/photo-1450778869180-41d0601e046e?w=800&q=80", "alt": "Pet owner", "caption": "Peace of mind for pet owners."}
  ],
  "introduction": "400+ words",
  "sections": [
    {"heading": "Unique H2", "content": "500+ words"},
    {"heading": "Different H2", "content": "500+ words"},
    {"heading": "Another H2", "content": "500+ words"},
    {"heading": "Final H2", "content": "500+ words"}
  ],
  "comparisonTable": {
    "headers": ["Provider", "Monthly Cost", "Deductible", "Reimbursement", "Annual Limit"],
    "rows": [
      ["Lemonade", "$15-40", "$100-500", "70-90%", "$5k-100k"],
      ["Healthy Paws", "$20-50", "$100-500", "70-90%", "Unlimited"],
      ["Trupanion", "$30-70", "$0-1000", "90%", "Unlimited"],
      ["ASPCA", "$18-45", "$100-500", "70-90%", "$5k-10k"]
    ]
  },
  "faqs": [
    {"question": "FAQ 1?", "answer": "150+ word answer"},
    {"question": "FAQ 2?", "answer": "150+ word answer"},
    {"question": "FAQ 3?", "answer": "150+ word answer"},
    {"question": "FAQ 4?", "answer": "150+ word answer"},
    {"question": "FAQ 5?", "answer": "150+ word answer"},
    {"question": "FAQ 6?", "answer": "150+ word answer"},
    {"question": "FAQ 7?", "answer": "150+ word answer"},
    {"question": "FAQ 8?", "answer": "150+ word answer"}
  ],
  "conclusion": "300+ words",
  "externalLinks": [{"url": "https://example.com", "text": "anchor", "context": "sentence"}],
  "internalLinks": [{"url": "/category/article-slug", "anchorText": "anchor", "context": "sentence"}],
  "providerProsCons": [
    {"provider": "Lemonade", "pros": ["3 pros"], "cons": ["3 cons"]},
    {"provider": "Healthy Paws", "pros": ["3 pros"], "cons": ["3 cons"]},
    {"provider": "Trupanion", "pros": ["3 pros"], "cons": ["3 cons"]},
    {"provider": "ASPCA", "pros": ["3 pros"], "cons": ["3 cons"]}
  ],
  "wordCount": 3500
}`;

    // Use Cloudflare Workers AI (replaced OpenRouter due to reliability issues)
    const aiResult = await generateWithCloudflareAI(prompt, { timeout: 600000 });
    const content = aiResult.content;
    const usedModel = aiResult.model;
    console.log(`☁️ [Cloudflare AI] Received response (${content.length} chars) using ${usedModel}`);

    // Extract JSON from response - robust extraction with string-aware brace matching
    let article: ArticleData;
    const jsonStart = content.indexOf('{');
    if (jsonStart === -1) {
      console.log('⚠️ [Cloudflare AI] No JSON found. Response preview:', content.substring(0, 500));
      throw new Error('No article JSON in Cloudflare AI response');
    }
    
    // String-aware brace matching (handles braces inside quoted strings)
    let braceCount = 0;
    let jsonEnd = -1;
    let inString = false;
    let escapeNext = false;
    
    for (let i = jsonStart; i < content.length; i++) {
      const char = content[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            jsonEnd = i + 1;
            break;
          }
        }
      }
    }
    
    if (jsonEnd === -1) {
      throw new Error('No valid JSON object found in Cloudflare AI response');
    }
    
    const rawJson = content.substring(jsonStart, jsonEnd);
    console.log(`🔍 [Cloudflare AI] Extracted JSON: ${rawJson.length} chars`);

    // Sanitize JSON - properly escape control characters inside strings
    // This handles newlines, tabs, and other control chars that break JSON.parse
    const sanitizedJson = rawJson
      // Remove all control characters except newline/tab/carriage return outside strings
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
      // Fix unescaped newlines inside JSON strings by converting them to escaped \\n
      .replace(/"([^"\\]|\\.)*"/g, (match) => {
        return match
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
      })
      .replace(/\n\s*\n/g, '\n');
    
    try {
      article = JSON.parse(sanitizedJson) as ArticleData;
    } catch (parseError: any) {
      console.log(`⚠️ [OpenRouter] Parse failed at position ${parseError.message.match(/position (\d+)/)?.[1] || 'unknown'}`);
      
      // Try progressively truncating to find valid JSON
      let lastValidBrace = sanitizedJson.lastIndexOf('}');
      while (lastValidBrace > 1000) {
        const truncated = sanitizedJson.substring(0, lastValidBrace + 1);
        // Count braces to ensure they're balanced
        const opens = (truncated.match(/{/g) || []).length;
        const closes = (truncated.match(/}/g) || []).length;
        
        if (opens === closes) {
          try {
            article = JSON.parse(truncated) as ArticleData;
            console.log(`✅ [OpenRouter] Recovered JSON by truncating at position ${lastValidBrace}`);
            break;
          } catch (e) {
            // Try next closing brace
          }
        }
        lastValidBrace = sanitizedJson.lastIndexOf('}', lastValidBrace - 1);
      }
      
      if (!article!) {
        throw parseError;
      }
    }
    console.log(`✅ [OpenRouter] Generated: ${article.title}`);

    // Enforce SEO limits - truncate title and meta description
    const seoLimits = enforceSEOLimits(article);
    article.title = seoLimits.title;
    article.metaDescription = seoLimits.metaDescription;

    // Search for relevant YouTube video
    let video: YouTubeVideo | undefined;
    try {
      const videoResult = searchYouTubeVideo(keyword);
      if (videoResult.success && videoResult.videos && videoResult.videos.length > 0) {
        video = videoResult.videos[0];
        console.log(`🎬 [YouTube] Found video: "${video.title}" by ${video.channel}`);
      }
    } catch (err: any) {
      console.log(`⚠️ [YouTube] Search skipped: ${err.message}`);
    }

    // Build HTML and deploy to Cloudflare KV - pass activeCategoryContext for dynamic breadcrumbs/URLs
    const html = buildArticleHtml(article, slug, keyword, video, activeCategoryContext);
    
    // Calculate SEO score
    const seoScore = await calculateSEOScore(html, keyword, article.title, article.metaDescription);
    console.log(`📊 [SEO Score] ${slug}: ${seoScore.score}/100`);
    
    // Track worker stats
    updateWorkerStats('cloudflare', seoScore.score);
    
    const deployResult = await deployToCloudflareKV(slug, html);

    if (deployResult.success) {
      console.log(`☁️ [OpenRouter] Deployed to KV: ${slug}`);
    }

    // Use dynamic category context for liveUrl
    const categoryPath = activeCategoryContext?.basePath || '/petinsurance';
    const categoryDomainForUrl = activeCategoryContext?.domain || 'catsluvus.com';
    
    return {
      success: true,
      article,
      slug,
      deployed: deployResult.success,
      liveUrl: deployResult.success ? `https://${categoryDomainForUrl}${categoryPath}/${slug}` : null,
      seoScore: seoScore.score,
      worker: 'cloudflare',
      model: usedModel,  // Track which Cloudflare AI model was used
      serpAnalysis: {
        competitorsAnalyzed: serpAnalysis.topResults.length,
        topicsFound: serpAnalysis.commonTopics,
        contentGaps: serpAnalysis.contentGaps,
        targetWordCount: serpAnalysis.targetWordCount,
        avgCompetitorWordCount: serpAnalysis.avgWordCount
      }
    } as any;

  } catch (error: any) {
    console.error(`❌ [OpenRouter] Error:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Apply performance optimizations to HTML before deployment
 * Adds preconnect hints, lazy loading, and other PageSpeed improvements
 */
function optimizeHtmlForPerformance(html: string): string {
  let optimized = html;
  
  // 1. Add preconnect hints for common CDNs (insert after <head>)
  const preconnectHints = `
    <link rel="preconnect" href="https://fonts.googleapis.com" crossorigin>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="preconnect" href="https://www.youtube.com" crossorigin>
    <link rel="preconnect" href="https://i.ytimg.com" crossorigin>
    <link rel="dns-prefetch" href="https://www.googletagmanager.com">
  `;
  
  if (!optimized.includes('rel="preconnect"')) {
    optimized = optimized.replace(/<head>/i, `<head>${preconnectHints}`);
  }
  
  // 2. Add loading="lazy" to images that don't have it
  optimized = optimized.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy" ');
  
  // 3. Add decoding="async" to images
  optimized = optimized.replace(/<img(?![^>]*decoding=)/gi, '<img decoding="async" ');
  
  // 4. Convert YouTube embeds to lite-youtube facade for massive performance boost
  const youtubeRegex = /<iframe[^>]*src="https?:\/\/(?:www\.)?youtube\.com\/embed\/([^"?]+)[^"]*"[^>]*><\/iframe>/gi;
  optimized = optimized.replace(youtubeRegex, (match, videoId) => {
    return `<lite-youtube videoid="${videoId}" style="background-image: url('https://i.ytimg.com/vi/${videoId}/hqdefault.jpg');"></lite-youtube>
    <script>if(!window.liteYT){window.liteYT=1;document.head.insertAdjacentHTML('beforeend','<style>lite-youtube{display:block;position:relative;width:100%;padding-bottom:56.25%;background-size:cover;background-position:center;cursor:pointer}lite-youtube::before{content:"";position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:68px;height:48px;background:url("data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' viewBox=\\'0 0 68 48\\'%3E%3Cpath fill=\\'%23f00\\' d=\\'M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z\\'/%3E%3Cpath fill=\\'%23fff\\' d=\\'M45 24L27 14v20z\\'/%3E%3C/svg%3E") center/contain no-repeat}lite-youtube:hover::before{filter:brightness(1.1)}</style>');document.addEventListener('click',e=>{const t=e.target.closest('lite-youtube');if(t){const v=t.getAttribute('videoid');t.outerHTML='<iframe src="https://www.youtube.com/embed/'+v+'?autoplay=1" frameborder="0" allow="autoplay;encrypted-media" allowfullscreen style="position:absolute;top:0;left:0;width:100%;height:100%"></iframe>'}})}</script>`;
  });
  
  // 5. Defer non-critical scripts
  optimized = optimized.replace(/<script(?![^>]*(?:defer|async|type="application\/ld\+json"))/gi, '<script defer ');
  
  // 6. Add fetchpriority="high" to hero images (first image)
  let firstImageReplaced = false;
  optimized = optimized.replace(/<img/i, (match) => {
    if (!firstImageReplaced) {
      firstImageReplaced = true;
      return '<img fetchpriority="high" ';
    }
    return match;
  });
  
  console.log(`[Perf] Applied HTML optimizations (preconnect, lazy load, YouTube facade, defer scripts)`);
  return optimized;
}

/**
 * Deploy article HTML to Cloudflare KV
 * @param slug - Article slug (e.g., "best-cat-dna-tests")
 * @param html - Article HTML content
 * @param category - Category slug (e.g., "cat-dna-testing" or "petinsurance"). Defaults to "petinsurance" for V1 compatibility.
 */
async function deployToCloudflareKV(slug: string, html: string, category: string = 'petinsurance'): Promise<{ success: boolean; error?: string }> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;

  if (!cfApiToken) {
    return { success: false, error: 'Cloudflare API token not configured' };
  }

  // Apply performance optimizations before deploying
  const optimizedHtml = optimizeHtmlForPerformance(html);

  try {
    // Use category:slug format for KV key (Worker expects this format for routing)
    const kvKey = `${category}:${slug}`;
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(kvKey)}`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${cfApiToken}`,
        'Content-Type': 'text/html'
      },
      body: optimizedHtml
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Cloudflare KV Error:', errorText);
      return { success: false, error: `KV deployment failed: ${response.status}` };
    }

    console.log(`☁️ Deployed to Cloudflare KV: ${kvKey}`);

    // Automatically update sitemap with new article
    await updateSitemapWithArticle(slug, category);

    // Notify Google Search Console of new article
    const articleUrl = `https://catsluvus.com/${category}/${slug}`;
    notifyGoogleOfNewArticle(articleUrl).then(() => {
      addActivityLog('success', `🔔 GSC: Indexing requested`, { keyword: slug, url: articleUrl });
    }).catch(err => {
      console.log(`[GSC] Background notification failed: ${err.message}`);
      addActivityLog('info', `⚠️ GSC: ${err.message}`, { keyword: slug });
    });

    // Validate rich results using URL Inspection API (run in background)
    validateArticleRichResults(articleUrl).then(result => {
      const richResultsTestUrl = `https://search.google.com/test/rich-results?url=${encodeURIComponent(articleUrl)}`;
      if (result.valid) {
        const types = result.detectedTypes.join(', ');
        addActivityLog('success', `🎯 Rich Results: Valid (${types})`, { keyword: slug, url: articleUrl, richResultsUrl: richResultsTestUrl });
      } else if (result.errors.length > 0) {
        addActivityLog('error', `❌ Rich Results: ${result.errors.length} errors - ${result.errors[0]}`, { keyword: slug, url: articleUrl, richResultsUrl: richResultsTestUrl });
      } else if (result.warnings.length > 0) {
        addActivityLog('info', `⚠️ Rich Results: ${result.warnings.length} warnings`, { keyword: slug, url: articleUrl, richResultsUrl: richResultsTestUrl });
      }
    }).catch(err => {
      console.log(`[Rich Results] Background validation failed: ${err.message}`);
    });

    return { success: true };
  } catch (error: any) {
    console.error('Cloudflare deployment error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Save research phase output and CategoryContext to KV for persistence
 */
async function saveResearchToKV(researchOutput: ResearchPhaseOutput, categoryContext: CategoryContext | null): Promise<{ success: boolean; error?: string }> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;

  if (!cfApiToken) {
    return { success: false, error: 'Cloudflare API token not configured' };
  }

  try {
    const kvPrefix = categoryContext?.kvPrefix || 'research:';
    const researchKey = `${kvPrefix}research-output`;
    const contextKey = `${kvPrefix}category-context`;

    const researchUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(researchKey)}`;

    await fetch(researchUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${cfApiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(researchOutput)
    });

    if (categoryContext) {
      const contextUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(contextKey)}`;

      await fetch(contextUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${cfApiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(categoryContext)
      });
    }

    console.log(`☁️ Research saved to KV: ${researchKey}`);
    return { success: true };
  } catch (error: any) {
    console.error('Failed to save research to KV:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Load research phase output and CategoryContext from KV
 */
async function loadResearchFromKV(kvPrefix: string): Promise<{ researchOutput: ResearchPhaseOutput | null; categoryContext: CategoryContext | null }> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;

  if (!cfApiToken) {
    return { researchOutput: null, categoryContext: null };
  }

  try {
    const researchKey = `${kvPrefix}research-output`;
    const contextKey = `${kvPrefix}category-context`;

    const researchUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(researchKey)}`;
    const contextUrl = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(contextKey)}`;

    const [researchRes, contextRes] = await Promise.all([
      fetch(researchUrl, { headers: { 'Authorization': `Bearer ${cfApiToken}` } }),
      fetch(contextUrl, { headers: { 'Authorization': `Bearer ${cfApiToken}` } })
    ]);

    let researchOutput: ResearchPhaseOutput | null = null;
    let categoryContext: CategoryContext | null = null;

    if (researchRes.ok) {
      researchOutput = await researchRes.json() as ResearchPhaseOutput;
    }
    if (contextRes.ok) {
      categoryContext = await contextRes.json() as CategoryContext;
    }

    return { researchOutput, categoryContext };
  } catch (error: any) {
    console.error('Failed to load research from KV:', error);
    return { researchOutput: null, categoryContext: null };
  }
}

/**
 * Fetch current sitemap from public URL (the worker serves it)
 * @param categorySlug - Category slug for dynamic sitemap URL (defaults to current context)
 */
async function fetchCurrentSitemap(categorySlug?: string): Promise<string | null> {
  try {
    // Use category from context or parameter for dynamic sitemap URL
    const category = categorySlug || v3CategoryContext?.category || 'petinsurance';
    const sitemapUrl = `https://catsluvus.com/${category}/sitemap.xml`;
    const response = await fetch(sitemapUrl, {
      headers: {
        'User-Agent': 'SitemapUpdater/1.0'
      }
    });

    if (!response.ok) {
      console.log('Could not fetch existing sitemap from public URL');
      return null;
    }

    const sitemap = await response.text();
    // Verify it's valid XML
    if (!sitemap.includes('<?xml') || !sitemap.includes('<urlset')) {
      console.log('Invalid sitemap format received');
      return null;
    }

    return sitemap;
  } catch (error) {
    console.error('Error fetching sitemap:', error);
    return null;
  }
}

/**
 * Update sitemap with a new article URL
 * @param slug - Article slug
 * @param category - Category slug (e.g., "cat-dna-testing" or "petinsurance"). Defaults to "petinsurance".
 */
async function updateSitemapWithArticle(slug: string, category: string = 'petinsurance'): Promise<boolean> {
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) {
    console.error('Cannot update sitemap: No Cloudflare API token');
    return false;
  }

  try {
    const articleUrl = `https://catsluvus.com/${category}/${slug}`;
    const today = new Date().toISOString().split('T')[0];

    // Fetch existing sitemap from public URL
    let sitemap = await fetchCurrentSitemap();

    if (sitemap) {
      // Check if URL already exists in sitemap
      if (sitemap.includes(`<loc>${articleUrl}</loc>`)) {
        console.log(`📍 Article already in sitemap: ${slug}`);
        addActivityLog('info', `📍 Sitemap: Article already indexed`, { keyword: slug, url: articleUrl });
        return true;
      }

      // Add new URL entry before closing </urlset> tag
      const newEntry = `  <url>
    <loc>${articleUrl}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`;

      sitemap = sitemap.replace('</urlset>', newEntry);
    } else {
      // Create new sitemap from scratch
      sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
        xsi:schemaLocation="http://www.sitemaps.org/schemas/sitemap/0.9
        http://www.sitemaps.org/schemas/sitemap/0.9/sitemap.xsd">
  <url>
    <loc>https://catsluvus.com/petinsurance/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${articleUrl}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`;
    }

    // Upload updated sitemap to KV
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/sitemap.xml`;

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${cfApiToken}`,
        'Content-Type': 'application/xml'
      },
      body: sitemap
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Sitemap update error:', errorText);
      return false;
    }

    console.log(`🗺️ Sitemap updated with: ${slug}`);
    addActivityLog('success', `🗺️ Sitemap: Added new article`, { keyword: slug, url: articleUrl });

    // Purge Cloudflare cache for sitemap
    await purgeSitemapCache(cfApiToken);

    return true;
  } catch (error) {
    console.error('Error updating sitemap:', error);
    return false;
  }
}

/**
 * Purge Cloudflare cache for the sitemap URL
 * Supports both Global API Key (full access) and API Token authentication
 * @param cfApiToken - Cloudflare API token
 * @param categorySlug - Category slug for dynamic sitemap URL (defaults to current context)
 */
async function purgeSitemapCache(cfApiToken: string, categorySlug?: string): Promise<boolean> {
  try {
    const purgeUrl = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`;

    // Check for Global API Key (has full permissions including cache purge)
    const globalApiKey = secrets.get('CLOUDFLARE_GLOBAL_API_KEY') || process.env.CLOUDFLARE_GLOBAL_API_KEY;
    const accountEmail = 'Webmaster@techfundoffice.com';

    // Build headers based on available credentials
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (globalApiKey) {
      // Use Global API Key authentication (full access)
      headers['X-Auth-Email'] = accountEmail;
      headers['X-Auth-Key'] = globalApiKey;
    } else {
      // Fall back to API Token (may not have cache purge permission)
      headers['Authorization'] = `Bearer ${cfApiToken}`;
    }

    // Use dynamic category for sitemap URL
    const category = categorySlug || v3CategoryContext?.category || 'petinsurance';
    const response = await fetch(purgeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        files: [
          `https://catsluvus.com/${category}/sitemap.xml`,
          `https://www.catsluvus.com/${category}/sitemap.xml`
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      if (errorData.errors?.[0]?.code === 10000) {
        console.warn('⚠️ Cache purge skipped: API token lacks cache purge permission.');
        console.warn('   Add CLOUDFLARE_GLOBAL_API_KEY to Doppler for instant cache purge.');
        console.warn('   Sitemap will update within 1 hour via normal cache expiry.');
        return false;
      }
      console.error('Cache purge error:', JSON.stringify(errorData));
      return false;
    }

    console.log('🧹 Sitemap cache purged - changes visible immediately');
    return true;
  } catch (error) {
    console.error('Error purging cache:', error);
    return false;
  }
}

// In-memory storage for recent articles (in production, use database)
let recentArticles: Array<{
  keyword: string;
  slug: string;
  title: string;
  wordCount: number;
  date: string;
  deployed: boolean;
  liveUrl: string | null;
  skillScore?: number;
  deployAction?: 'deploy' | 'review' | 'optimize' | 'reject';
}> = [];

// Activity log for detailed real-time updates
interface ActivityLogEntry {
  id: number;
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'generating' | 'deployed' | 'queue' | 'warning';
  message: string;
  // Allow any details object for flexibility with various logging contexts
  details?: Record<string, any>;
}

let activityLog: ActivityLogEntry[] = [];
let activityLogId = 0;

function addActivityLog(
  type: ActivityLogEntry['type'],
  message: string,
  details?: ActivityLogEntry['details']
) {
  const entry: ActivityLogEntry = {
    id: ++activityLogId,
    timestamp: new Date().toISOString(),
    type,
    message,
    details
  };
  activityLog.unshift(entry);
  // Keep only last 200 entries
  if (activityLog.length > 200) {
    activityLog = activityLog.slice(0, 200);
  }
  console.log(`[SEO-GEN] ${type.toUpperCase()}: ${message}`, details || '');
}

// Stats tracking (uses actual keyword count)
let stats = {
  totalKeywords: ALL_KEYWORDS.length,
  generated: 0,
  pending: ALL_KEYWORDS.length,
  percentComplete: '0.0'
};

/**
 * Get generator status
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json({
      totalKeywords: stats.totalKeywords,
      pagesComplete: stats.generated,
      pagesNeeded: stats.pending,
      percentComplete: stats.percentComplete,
      lastUpdated: new Date().toISOString(),
      version: 'v3',
      skillsEnabled: true
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to get status'
    });
  }
});

// ============================================================================
// V3: SKILL-BASED ENDPOINTS
// ============================================================================

/**
 * V3: Validate article content with skill-based rules
 */

/**
 * Generate Product schema from comparison table
 * Helps Google display rich product results in search
 * Uses Amazon affiliate links for product URLs
 */
function generateProductSchema(
  comparisonHeaders: string[],
  comparisonRows: string[][],
  externalLinks: Array<{url: string, text: string, context?: string}>,
  keyword: string
): object | null {
  
  if (!comparisonRows || comparisonRows.length === 0) {
    return null;
  }
  
  const amazonTag = process.env.AMAZON_AFFILIATE_TAG || 'catsluvus03-20';
  
  const products = comparisonRows.map((row, index) => {
    const productName = row[0] || 'Unknown Product'; // First column is product name
    const priceStr = row[1] || '$0'; // Second column is price
    
    // Extract numeric price (remove $, commas, handle ranges by taking first number)
    const priceMatch = priceStr.match(/\$?(\d+)/);
    const priceValue = priceMatch ? priceMatch[1] : '0';
    
    // Check if last column contains Amazon search query
    const lastCol = row[row.length - 1] || '';
    const isAmazonSearch = lastCol.includes('+') || comparisonHeaders[comparisonHeaders.length - 1]?.toLowerCase().includes('amazon');
    
    // Build Amazon affiliate URL
    const searchQuery = isAmazonSearch 
      ? lastCol.replace(/\+/g, ' ') 
      : productName;
    const amazonUrl = `https://www.amazon.com/s?k=${encodeURIComponent(searchQuery)}&tag=${amazonTag}`;
    
    // Build description from middle columns (skip first=name, last=amazon search)
    const featureColumns = isAmazonSearch ? row.slice(2, -1) : row.slice(2);
    const featureHeaders = isAmazonSearch ? comparisonHeaders.slice(2, -1) : comparisonHeaders.slice(2);
    const features = featureColumns.map((val, i) => 
      `${featureHeaders[i] || 'Feature'}: ${val}`
    ).join(', ');
    
    const description = features ? `${productName} - ${features}` : productName;
    
    return {
      "@type": "ListItem",
      "position": index + 1,
      "item": {
        "@type": "Product",
        "name": productName,
        "description": description,
        "offers": {
          "@type": "Offer",
          "price": priceValue,
          "priceCurrency": "USD",
          "availability": "https://schema.org/InStock",
          "url": amazonUrl
        }
      }
    };
  });
  
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "name": `Best ${keyword} Comparison`,
    "description": `Comparison of top ${keyword} products`,
    "itemListElement": products
  };
}


router.post('/validate', async (req: Request, res: Response) => {
  try {
    const { html, keyword, profile = 'comprehensive' } = req.body;

    if (!html || !keyword) {
      return res.status(400).json({ error: 'Missing required fields: html, keyword' });
    }

    const engine = SkillEngine.fromProfile(profile);
    const validation = engine.validateContent(html, keyword);
    const recommendation = getDeploymentRecommendation(validation.score);

    res.json({
      success: true,
      validation,
      recommendation,
      loadedSkills: engine.getLoadedSkills(),
      profile
    });
  } catch (error: any) {
    console.error('[V3 Validate] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * V3: Comprehensive audit of article content
 */
router.post('/audit', async (req: Request, res: Response) => {
  try {
    const { html, keyword, profile = 'comprehensive' } = req.body;

    if (!html || !keyword) {
      return res.status(400).json({ error: 'Missing required fields: html, keyword' });
    }

    const engine = SkillEngine.fromProfile(profile);
    const audit = engine.auditContent(html, keyword);
    const recommendation = getDeploymentRecommendation(audit.overallScore);

    res.json({
      success: true,
      audit,
      recommendation,
      loadedSkills: engine.getLoadedSkills(),
      qualityGates: QUALITY_GATES,
      profile
    });
  } catch (error: any) {
    console.error('[V3 Audit] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * V3: Get available skill profiles
 */
router.get('/skills/profiles', async (_req: Request, res: Response) => {
  try {
    const { SEO_SKILL_PROFILES, QUALITY_GATES } = await import('../config/seo-skills');

    // Return profiles as object with profile IDs as keys (for easy lookup)
    res.json({
      profiles: SEO_SKILL_PROFILES,
      qualityGates: QUALITY_GATES
    });
  } catch (error: any) {
    console.error('[V3 Skills] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * V3: Get best practices for a profile (for prompt enhancement)
 */
router.get('/skills/best-practices', async (req: Request, res: Response) => {
  try {
    const profile = (req.query.profile as string) || 'comprehensive';
    const engine = SkillEngine.fromProfile(profile);
    const bestPractices = engine.getBestPracticesForPrompt();

    res.json({
      success: true,
      profile,
      loadedSkills: engine.getLoadedSkills(),
      bestPractices,
      skillCount: engine.getLoadedSkills().length
    });
  } catch (error: any) {
    console.error('[V3 Best Practices] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Simple in-memory cache for SERP analysis (expires after 1 hour)
const serpCache = new Map<string, { data: any; timestamp: number }>();
const SERP_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Analyze Google SERP for a keyword to understand what's ranking
 * Includes caching to avoid repeated API calls
 */
async function analyzeSERP(keyword: string): Promise<{
  topResults: Array<{ title: string; description: string; url: string }>;
  avgTitleLength: number;
  commonTopics: string[];
  contentGaps: string[];
  targetWordCount: number;
  competitorHeadings: string[];
  competitorFAQs: string[];
  competitorEntities: string[];
  avgWordCount: number;
}> {
  // Check cache first
  const cacheKey = keyword.toLowerCase().trim();
  const cached = serpCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SERP_CACHE_TTL) {
    console.log(`📦 [SERP Cache] Using cached analysis for: "${keyword}"`);
    return cached.data;
  }

  try {
    // SERP API priority: Serper (2500 free/month) > Google CSE (100/day) > Outscraper > DuckDuckGo
    const serperKey = process.env.SERPER_API_KEY;
    const googleApiKey = process.env.GOOGLE_API_KEY;
    const googleCseId = process.env.GOOGLE_CSE_ID;
    const outscraperKey = process.env.OUTSCRAPER_API_KEY;

    let results: any[] = [];

    // Try Serper first (best free tier: 2500 queries/month)
    if (serperKey) {
      console.log('🔍 [SERP] Using Serper.dev API');
      try {
        const serperResponse = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: {
            'X-API-KEY': serperKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            q: keyword,
            gl: 'us',
            hl: 'en',
            num: 10
          })
        });

        if (serperResponse.ok) {
          const serperData = await serperResponse.json() as any;
          results = (serperData?.organic || []).map((item: any) => ({
            title: item.title || '',
            description: item.snippet || '',
            link: item.link || ''
          }));
          console.log(`✅ [SERP] Serper returned ${results.length} results`);
        } else {
          console.log(`⚠️ [SERP] Serper failed (${serperResponse.status}), trying fallback...`);
        }
      } catch (serperErr: any) {
        console.log(`⚠️ [SERP] Serper error: ${serperErr.message}`);
      }
    }

    // Fallback to Google CSE
    if (results.length === 0 && googleApiKey && googleCseId) {
      console.log('🔍 [SERP] Using Google Custom Search API');
      const googleResponse = await fetch(
        `https://www.googleapis.com/customsearch/v1?` + new URLSearchParams({
          key: googleApiKey,
          cx: googleCseId,
          q: keyword,
          num: '10',
          gl: 'us',
          hl: 'en'
        })
      );

      if (googleResponse.ok) {
        const googleData = await googleResponse.json() as any;
        results = (googleData?.items || []).map((item: any) => ({
          title: item.title || '',
          description: item.snippet || '',
          link: item.link || ''
        }));
        console.log(`✅ [SERP] Google CSE returned ${results.length} results`);
      } else {
        console.log(`⚠️ [SERP] Google CSE failed (${googleResponse.status}), trying fallback...`);
      }
    }

    // Fallback to Outscraper
    if (results.length === 0 && outscraperKey) {
      console.log('🔍 [SERP] Falling back to Outscraper API');
      const response = await fetch('https://api.app.outscraper.com/google-search-v3?' + new URLSearchParams({
        query: keyword,
        language: 'en',
        region: 'US',
        limit: '10'
      }), {
        headers: {
          'X-API-KEY': outscraperKey
        }
      });

      if (response.ok) {
        const data = await response.json() as any;
        results = (data?.data?.[0]?.organic_results || []).map((r: any) => ({
          title: r.title || '',
          description: r.description || '',
          link: r.link || ''
        }));
      }
    }

    // Fallback to DuckDuckGo Instant Answer API (FREE, no API key required)
    if (results.length === 0) {
      console.log('🦆 [SERP] Trying DuckDuckGo (free, no API key)...');
      try {
        const ddgResponse = await fetch(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(keyword)}&format=json&no_html=1&skip_disambig=1`
        );
        if (ddgResponse.ok) {
          const ddgData = await ddgResponse.json() as any;
          const relatedTopics = ddgData?.RelatedTopics || [];
          results = relatedTopics
            .filter((t: any) => t.Text && t.FirstURL)
            .slice(0, 10)
            .map((t: any) => ({
              title: t.Text?.split(' - ')[0] || t.Text?.substring(0, 60) || '',
              description: t.Text || '',
              link: t.FirstURL || ''
            }));
          if (results.length > 0) {
            console.log(`✅ [SERP] DuckDuckGo returned ${results.length} related topics`);
          }
        }
      } catch (ddgError: any) {
        console.log(`⚠️ [SERP] DuckDuckGo failed: ${ddgError.message}`);
      }
    }

    // If all APIs failed, use defaults
    if (results.length === 0) {
      console.log('⚠️ No SERP API available - using default analysis');
      return getDefaultSERPAnalysis(keyword);
    }

    const topResults = results.slice(0, 10).map((r: any) => ({
      title: r.title || '',
      description: r.description || '',
      url: r.link || r.url || ''
    }));

    // Analyze patterns from top results
    const titles = topResults.map((r: { title: string }) => r.title);
    const avgTitleLength = titles.length > 0 ? titles.reduce((sum: number, t: string) => sum + t.length, 0) / titles.length : 55;

    // Extract common topics from titles and descriptions
    const allText = topResults.map((r: { title: string; description: string }) => `${r.title} ${r.description}`).join(' ').toLowerCase();
    const commonTopics = extractTopics(allText, keyword);

    // Identify content gaps - topics competitors might be missing
    const contentGaps = identifyContentGaps(keyword, commonTopics);

    // Scrape competitor pages for headings, FAQs, and word counts
    const competitorUrls = topResults.map((r: { url: string }) => r.url).filter((u: string) => u);
    const competitorAnalysis = await analyzeCompetitorPages(competitorUrls);

    // Target word count: beat competitors by 20%
    const targetWordCount = Math.max(3500, Math.round(competitorAnalysis.avgWordCount * 1.2));

    console.log(`🔍 SERP Analysis: ${topResults.length} competitors, avg title ${Math.round(avgTitleLength)} chars`);
    console.log(`📊 Topics: ${commonTopics.slice(0, 5).join(', ')}`);
    console.log(`📑 Competitor headings: ${competitorAnalysis.allHeadings.length} found - ${competitorAnalysis.allHeadings.slice(0, 5).join(' | ')}`);
    console.log(`❓ Competitor FAQs: ${competitorAnalysis.allFAQs.length} found - ${competitorAnalysis.allFAQs.slice(0, 3).join(' | ')}`);
    console.log(`🎯 Gaps to exploit: ${contentGaps.slice(0, 3).join(', ')}`);
    console.log(`📝 Target word count: ${targetWordCount} (competitors avg: ${competitorAnalysis.avgWordCount})`);

    // Telemetry: Log extraction quality
    const extractionQuality = {
      headingsFound: competitorAnalysis.allHeadings.length,
      faqsFound: competitorAnalysis.allFAQs.length,
      entitiesFound: competitorAnalysis.allEntities.length,
      pagesScraped: competitorUrls.length,
      avgWordCount: competitorAnalysis.avgWordCount
    };
    console.log(`📈 [SERP Telemetry] Extraction quality:`, JSON.stringify(extractionQuality));

    const result = { 
      topResults, 
      avgTitleLength, 
      commonTopics, 
      contentGaps, 
      targetWordCount,
      competitorHeadings: competitorAnalysis.allHeadings,
      competitorFAQs: competitorAnalysis.allFAQs,
      competitorEntities: competitorAnalysis.allEntities,
      avgWordCount: competitorAnalysis.avgWordCount
    };

    // Cache the result
    serpCache.set(cacheKey, { data: result, timestamp: Date.now() });
    console.log(`💾 [SERP Cache] Cached analysis for: "${keyword}"`);

    return result;

  } catch (error: any) {
    console.log('⚠️ SERP analysis error:', error.message);
    return getDefaultSERPAnalysis(keyword);
  }
}

function getDefaultSERPAnalysis(keyword: string) {
  return {
    topResults: [],
    avgTitleLength: 55,
    commonTopics: ['cost', 'coverage', 'best providers', 'comparison', 'reviews', 'deductible', 'claims'],
    contentGaps: ['real claim payout data', 'veterinarian expert quotes', 'breed-specific pricing', 'state-by-state cost comparison', 'hidden exclusions exposed'],
    targetWordCount: 3500,
    competitorHeadings: [] as string[],
    competitorFAQs: [] as string[],
    competitorEntities: ['Lemonade', 'Healthy Paws', 'Trupanion', 'ASPCA', 'deductible', 'reimbursement', 'waiting period'] as string[],
    avgWordCount: 2500
  };
}

/**
 * Scrape a competitor page to extract H2/H3 headings, FAQs, entities, and word count
 * Uses cheerio for reliable DOM parsing
 */
async function scrapeCompetitorPage(url: string): Promise<{
  headings: string[];
  faqs: string[];
  entities: string[];
  wordCount: number;
}> {
  try {
    // Skip non-article URLs (PDFs, images, etc.)
    if (url.match(/\.(pdf|jpg|png|gif|mp4)$/i)) {
      return { headings: [], faqs: [], entities: [], wordCount: 0 };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout per page

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { headings: [], faqs: [], entities: [], wordCount: 0 };
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract H2 and H3 headings using DOM
    const headings: string[] = [];
    $('h2, h3').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 100) {
        headings.push(text);
      }
    });

    // Extract FAQ questions from multiple sources
    const faqs: string[] = [];
    
    // 1. Questions in any heading (h1-h6)
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      const text = $(el).text().trim();
      if (text.includes('?') && text.length > 10 && text.length < 200) {
        if (!faqs.includes(text)) faqs.push(text);
      }
    });

    // 2. JSON-LD FAQ Schema
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html() || '');
        const extractFAQs = (obj: any) => {
          if (obj['@type'] === 'Question' && obj.name) {
            if (!faqs.includes(obj.name)) faqs.push(obj.name);
          }
          if (obj['@type'] === 'FAQPage' && obj.mainEntity) {
            (Array.isArray(obj.mainEntity) ? obj.mainEntity : [obj.mainEntity]).forEach((q: any) => {
              if (q.name && !faqs.includes(q.name)) faqs.push(q.name);
            });
          }
          if (obj['@graph']) obj['@graph'].forEach(extractFAQs);
        };
        extractFAQs(json);
      } catch (e) { /* ignore parse errors */ }
    });

    // 3. FAQ elements by class/id
    $('[class*="faq"], [id*="faq"], [class*="question"], [id*="question"]').each((_, el) => {
      const text = $(el).text().trim();
      if (text.includes('?') && text.length > 10 && text.length < 200) {
        if (!faqs.includes(text)) faqs.push(text);
      }
    });

    // Extract key entities (brand names, insurance providers)
    const entities: string[] = [];
    const entityPatterns = [
      'Lemonade', 'Healthy Paws', 'Trupanion', 'ASPCA', 'Embrace', 'Nationwide', 
      'Pets Best', 'Figo', 'MetLife', 'Spot', 'Pumpkin', 'Fetch', 'ManyPets',
      'Pawlicy', 'veterinarian', 'deductible', 'premium', 'reimbursement',
      'waiting period', 'pre-existing', 'hereditary', 'wellness'
    ];
    const bodyText = $('body').text().toLowerCase();
    entityPatterns.forEach(entity => {
      if (bodyText.includes(entity.toLowerCase())) {
        entities.push(entity);
      }
    });

    // Estimate word count from main content
    const mainContent = $('article, main, .content, .post, [role="main"]').first();
    const contentText = mainContent.length ? mainContent.text() : $('body').text();
    const wordCount = contentText.split(/\s+/).filter(w => w.length > 2).length;

    return { 
      headings: headings.slice(0, 15), 
      faqs: faqs.slice(0, 10), 
      entities: entities.slice(0, 15),
      wordCount 
    };

  } catch (error: any) {
    // Silently fail for individual pages - don't block the whole analysis
    return { headings: [], faqs: [], entities: [], wordCount: 0 };
  }
}

/**
 * Analyze multiple competitor pages in parallel (with limit)
 */
async function analyzeCompetitorPages(urls: string[]): Promise<{
  allHeadings: string[];
  allFAQs: string[];
  allEntities: string[];
  avgWordCount: number;
}> {
  // Limit to top 5 pages to avoid timeout
  const topUrls = urls.slice(0, 5);

  console.log(`📄 Scraping ${topUrls.length} competitor pages for headings/FAQs/entities...`);

  const results = await Promise.all(topUrls.map(url => scrapeCompetitorPage(url)));

  // Aggregate results
  const allHeadings = new Set<string>();
  const allFAQs = new Set<string>();
  const allEntities = new Set<string>();
  const wordCounts: number[] = [];

  results.forEach(r => {
    r.headings.forEach(h => allHeadings.add(h));
    r.faqs.forEach(f => allFAQs.add(f));
    r.entities.forEach(e => allEntities.add(e));
    if (r.wordCount > 500) wordCounts.push(r.wordCount); // Only count substantial pages
  });

  const avgWordCount = wordCounts.length > 0 
    ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length)
    : 2500;

  console.log(`📊 Found ${allHeadings.size} headings, ${allFAQs.size} FAQs, ${allEntities.size} entities, avg ${avgWordCount} words`);

  return {
    allHeadings: Array.from(allHeadings),
    allFAQs: Array.from(allFAQs),
    allEntities: Array.from(allEntities),
    avgWordCount
  };
}

function extractTopics(text: string, keyword: string): string[] {
  const topics = new Set<string>();
  const patterns = [
    'cost', 'price', 'cheap', 'affordable', 'expensive', 'worth it',
    'best', 'top', 'review', 'comparison', 'vs', 'rated',
    'coverage', 'deductible', 'premium', 'reimbursement', 'payout',
    'breed', 'puppy', 'kitten', 'senior', 'young', 'age',
    'accident', 'illness', 'wellness', 'preventive', 'routine',
    'claim', 'wait', 'exclude', 'pre-existing', 'hereditary',
    'lemonade', 'healthy paws', 'trupanion', 'embrace', 'nationwide', 'pets best'
  ];

  patterns.forEach(p => {
    if (text.includes(p)) topics.add(p);
  });

  return Array.from(topics);
}

function identifyContentGaps(keyword: string, existingTopics: string[]): string[] {
  const allPossibleTopics = [
    'actual customer claim amounts with real dollar figures',
    'veterinarian expert recommendations and quotes',
    'breed-specific pricing data tables',
    'state-by-state cost comparison data',
    'hidden exclusions and gotchas to avoid',
    'claim denial rate statistics by provider',
    'step-by-step claim filing walkthrough',
    'multi-pet discount calculator',
    'annual vs per-incident deductible math examples',
    'real customer testimonials with specific outcomes',
    'emergency vet cost breakdown by procedure',
    'waiting period comparison chart',
    'pre-existing condition workarounds'
  ];

  // Return topics not well covered by competitors
  return allPossibleTopics.filter(t =>
    !existingTopics.some(et => t.toLowerCase().includes(et))
  ).slice(0, 6);
}

/**
 * Test endpoint - verify Copilot CLI connectivity
 * Uses direct CLI invocation with -p flag (what the SDK wraps internally)
 */
router.get('/test-sdk', async (_req: Request, res: Response) => {
  try {
    console.log('🧪 [CLI Test] Starting Copilot CLI test...');

    // Simple prompt without quotes to avoid escaping issues
    const response = await generateWithCopilotCLI(
      'What is 2 plus 2? Reply with just the number.',
      30000 // 30 second timeout
    );

    console.log(`🧪 [CLI Test] Response: ${response}`);

    res.json({
      success: true,
      response: response.trim(),
      message: 'GitHub Copilot CLI is working!'
    });
  } catch (error: any) {
    console.error('🧪 [CLI Test] Error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      hint: 'Check GitHub Copilot enablement at https://github.com/settings/copilot'
    });
  }
});

/**
 * V3: Generate a single article with skill-enhanced pipeline
 * Integrates skill engine for post-generation auditing and quality gates
 * Uses Cloudflare AI for content generation
 */
router.post('/generate', async (req: Request, res: Response) => {
  const { keyword, skillProfile = 'comprehensive' } = req.body;

  if (!keyword || typeof keyword !== 'string') {
    return res.status(400).json({ error: 'Keyword is required' });
  }

  try {
    console.log(`🤖 V3 Skill-Enhanced generation: ${keyword} (profile: ${skillProfile})`);

    // V3: Initialize skill engine for post-generation audit
    const skillEngine = SkillEngine.fromProfile(skillProfile);
    const loadedSkills = skillEngine.getLoadedSkills();
    console.log(`📚 Loaded ${loadedSkills.length} skills: ${loadedSkills.join(', ')}`);

    // Log generation start to activity log
    addActivityLog('generating', `Generating: "${keyword}" (V3 with ${loadedSkills.length} skills)`, { keyword, skillProfile });

    const result = await generateWithCopilotSDK(keyword);

    if (!result.success) {
      // Check if it's a Copilot policy error
      if (result.error?.includes('No model available') || result.error?.includes('policy enablement')) {
        return res.status(503).json({
          error: 'GitHub Copilot is not enabled',
          message: 'Enable Copilot at https://github.com/settings/copilot for account: techfundoffice',
          details: result.error
        });
      }
      return res.status(500).json({ error: result.error });
    }

    const slug = keywordToSlug(keyword);

    // V3: Run post-generation skill audit
    let skillAudit = null;
    let deploymentRecommendation = null;
    if (result.liveUrl) {
      try {
        // Fetch the deployed HTML for auditing
        const response = await fetch(result.liveUrl);
        if (response.ok) {
          const deployedHtml = await response.text();
          skillAudit = skillEngine.auditContent(deployedHtml, keyword);
          deploymentRecommendation = getDeploymentRecommendation(skillAudit.overallScore);
          console.log(`📊 V3 Skill Audit: ${skillAudit.overallScore}/100 - ${deploymentRecommendation.action}`);
        }
      } catch (auditErr: any) {
        console.log(`⚠️ Skill audit skipped: ${auditErr.message}`);
      }
    }

    // Update stats
    stats.generated++;
    stats.pending = Math.max(0, stats.pending - 1);
    stats.percentComplete = ((stats.generated / stats.totalKeywords) * 100).toFixed(2);

    console.log(`✅ V3 Generated: ${slug}`);

    if (result.deployed) {
      console.log(`🌐 Live at: ${result.liveUrl}`);
    }

    // Store in recent articles with skill audit data
    recentArticles.unshift({
      keyword,
      slug,
      title: result.article!.title,
      wordCount: result.article!.wordCount || 3500,
      date: new Date().toISOString(),
      deployed: result.deployed || false,
      liveUrl: result.liveUrl || null,
      skillScore: skillAudit?.overallScore,
      deployAction: deploymentRecommendation?.action
    });
    recentArticles = recentArticles.slice(0, 50);

    // Log to activity log with skill audit info
    const manualSeoScore = (result as any).seoScore || 0;
    const skillScore = skillAudit?.overallScore || 0;
    const scoreDisplay = skillScore > 0
      ? `| SEO: ${manualSeoScore}/100 | Skills: ${skillScore}/100`
      : `| SEO: ${manualSeoScore}/100`;
    addActivityLog('success', `Generated: "${result.article!.title}" ${scoreDisplay}`, {
      keyword,
      slug,
      seoScore: manualSeoScore,
      skillScore,
      wordCount: result.article!.wordCount || 3500,
      url: result.liveUrl || undefined,
      deployAction: deploymentRecommendation?.action
    });

    if (result.deployed) {
      addActivityLog('deployed', `Deployed to Cloudflare KV ${deploymentRecommendation ? `(${deploymentRecommendation.action})` : ''}`, {
        keyword,
        slug,
        url: result.liveUrl || `https://catsluvus.com/petinsurance/${slug}`,
        skillScore
      });
    }

    return res.json({
      success: true,
      engine: 'cloudflare-ai-v3',
      slug,
      title: result.article!.title,
      wordCount: result.article!.wordCount || 3500,
      seoScore: manualSeoScore,
      preview: `<h1>${result.article!.title}</h1><p>${result.article!.introduction?.substring(0, 500)}...</p>`,
      deployed: result.deployed,
      liveUrl: result.liveUrl,
      serpAnalysis: result.serpAnalysis,
      // V3: Skill audit results
      skillAudit: skillAudit ? {
        overallScore: skillAudit.overallScore,
        categories: skillAudit.categories,
        issueCount: skillAudit.issues.length,
        issues: skillAudit.issues.slice(0, 10), // Top 10 issues
        recommendations: skillAudit.recommendations.slice(0, 5)
      } : null,
      deploymentRecommendation: deploymentRecommendation ? {
        action: deploymentRecommendation.action,
        message: deploymentRecommendation.message,
        qualityGates: QUALITY_GATES
      } : null,
      skillProfile,
      skillsLoaded: loadedSkills
    });

  } catch (error: any) {
    console.error('V3 Generation error:', error);
    return res.status(500).json({ error: error.message || 'Failed to generate article' });
  }
});

/**
 * Run batch generation
 */
router.post('/batch', async (req: Request, res: Response) => {
  const { count = 50 } = req.body;

  try {
    res.json({
      success: true,
      message: `Batch generation started for ${count} articles`,
      generated: 0,
      queued: count
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Batch generation failed'
    });
  }
});

/**
 * Get recent articles
 */
router.get('/recent', async (_req: Request, res: Response) => {
  res.json({
    articles: recentArticles,
    count: recentArticles.length
  });
});

/**
 * Get activity log for real-time updates
 */
router.get('/activity-log', async (req: Request, res: Response) => {
  const { since, limit = 50 } = req.query;

  let logs = activityLog;

  // Filter by since ID if provided
  if (since) {
    const sinceId = Number(since);
    logs = logs.filter(entry => entry.id > sinceId);
  }

  // Limit results
  logs = logs.slice(0, Number(limit));

  res.json({
    logs,
    count: logs.length,
    totalLogs: activityLog.length,
    latestId: activityLog[0]?.id || 0
  });
});

/**
 * Get sitemap URLs - fetches sitemap.xml and parses URLs for display
 * Uses current category context for dynamic sitemap URL
 */
router.get('/sitemap', async (_req: Request, res: Response) => {
  try {
    // Get category from current context or default
    const category = v3CategoryContext?.category || 'petinsurance';
    const sitemap = await fetchCurrentSitemap(category);

    if (!sitemap) {
      return res.json({
        urls: [],
        count: 0,
        error: 'Could not fetch sitemap'
      });
    }

    // Parse URLs from sitemap XML
    const urlMatches = sitemap.match(/<loc>([^<]+)<\/loc>/g) || [];
    const urls = urlMatches.map(match => {
      const url = match.replace(/<\/?loc>/g, '');
      // Extract slug from URL - use dynamic category pattern
      const slugMatch = url.match(new RegExp(`\\/${category}\\/([^/]+)\\/?$`));
      const slug = slugMatch ? slugMatch[1] : url;

      // Try to extract lastmod if present
      return {
        url,
        slug,
        title: slug.split('-').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      };
    });

    // Sort by slug alphabetically
    urls.sort((a, b) => a.slug.localeCompare(b.slug));

    res.json({
      urls,
      count: urls.length,
      source: `https://catsluvus.com/${category}/sitemap.xml`,
      fetchedAt: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to fetch sitemap',
      urls: [],
      count: 0
    });
  }
});

/**
 * Get all keywords (paginated)
 */
router.get('/keywords', async (req: Request, res: Response) => {
  const { limit = 100, offset = 0, search } = req.query;

  try {
    let keywords = ALL_KEYWORDS;

    // Filter by search if provided
    if (search && typeof search === 'string') {
      const searchLower = search.toLowerCase();
      keywords = keywords.filter(kw => kw.toLowerCase().includes(searchLower));
    }

    const start = Number(offset);
    const end = start + Number(limit);
    const paginatedKeywords = keywords.slice(start, end);

    res.json({
      keywords: paginatedKeywords,
      total: keywords.length,
      offset: start,
      limit: Number(limit)
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to load keywords'
    });
  }
});

/**
 * Get keyword stats
 */
router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const keywordStats = getKeywordStats();
    res.json({
      keywords: keywordStats,
      authors: EXPERT_AUTHORS.map(a => ({ name: a.name, credentials: a.credentials, expertise: a.expertise })),
      sources: Object.keys(CREDIBLE_SOURCES).length,
      thresholds: SEO_THRESHOLDS,
      entities: {
        base: ENTITIES.base.length,
        dog: ENTITIES.dog.length,
        cat: ENTITIES.cat.length
      },
      generated: stats.generated,
      pending: stats.pending
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to get stats'
    });
  }
});

/**
 * Get AI image generation quota status
 */
router.get('/image-quota', async (_req: Request, res: Response) => {
  try {
    const quota = getImageQuotaStatus();
    res.json({
      success: true,
      quota: {
        used: quota.used,
        limit: quota.limit,
        remaining: quota.remaining,
        resetDate: quota.resetDate,
        percentUsed: Math.round((quota.used / quota.limit) * 100)
      },
      info: {
        model: 'FLUX.1 schnell',
        resolution: '1024x768',
        neuronsPerImage: 58,
        dailyNeuronBudget: 10000
      }
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get image quota'
    });
  }
});

/**
 * Get random keywords for batch processing
 */
router.get('/keywords/random', async (req: Request, res: Response) => {
  const { count = 10 } = req.query;

  try {
    const shuffled = [...ALL_KEYWORDS].sort(() => 0.5 - Math.random());
    const randomKeywords = shuffled.slice(0, Number(count));

    res.json({
      keywords: randomKeywords,
      count: randomKeywords.length
    });
  } catch (error: any) {
    res.status(500).json({
      error: error.message || 'Failed to get random keywords'
    });
  }
});

// Autonomous mode state - runs continuously at max speed (no interval delay)
let autonomousRunning = false;

// V3 Research Phase State - must complete before generation can start
let researchEngine: ResearchEngine | null = null;
let researchPhaseOutput: ResearchPhaseOutput | null = null;
let activeCategoryContext: CategoryContext | null = null;
let researchPhaseStatus: ResearchPhaseStatus = 'idle';

// ANSI color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgCyan: '\x1b[46m'
};

// Create clickable hyperlink for terminals that support OSC 8
function hyperlink(url: string, text?: string): string {
  const displayText = text || url;
  return `\x1b]8;;${url}\x07${colors.cyan}${colors.bold}${displayText}${colors.reset}\x1b]8;;\x07`;
}

// Color-coded SEO score based on value
function coloredScore(score: number): string {
  if (score >= 90) return `${colors.bgGreen}${colors.bold} ${score}/100 ${colors.reset}`;
  if (score >= 80) return `${colors.green}${colors.bold}${score}/100${colors.reset}`;
  if (score >= 70) return `${colors.yellow}${colors.bold}${score}/100${colors.reset}`;
  return `${colors.red}${colors.bold}${score}/100${colors.reset}`;
}

// Heartbeat stats for 1-minute status logs
let heartbeatInterval: NodeJS.Timeout | null = null;
let lastHeartbeatTime = Date.now();
let articlesThisMinute = 0;
let recentSeoScores: number[] = [];
let lastGeneratedSlug = '';
const HEARTBEAT_INTERVAL_MS = 60000; // 1 minute

function startHeartbeat() {
  if (heartbeatInterval) return; // Already running
  
  lastHeartbeatTime = Date.now();
  articlesThisMinute = 0;
  recentSeoScores = [];
  
  heartbeatInterval = setInterval(() => {
    const avgScore = recentSeoScores.length > 0 
      ? Math.round(recentSeoScores.reduce((a, b) => a + b, 0) / recentSeoScores.length)
      : 0;
    
    const statusColor = autonomousRunning ? colors.bgGreen : colors.bgRed;
    const statusText = autonomousRunning ? ' RUNNING ' : ' STOPPED ';
    const rate = articlesThisMinute;
    const progress = `${stats.generated}/${ALL_KEYWORDS.length}`;
    const percent = stats.percentComplete;
    
    const lastUrl = lastGeneratedSlug 
      ? hyperlink(`https://catsluvus.com/petinsurance/${lastGeneratedSlug}`, lastGeneratedSlug)
      : 'none yet';
    
    // Worker stats display
    const copilotStats = workerStats.copilot.count > 0 
      ? `${workerStats.copilot.count} articles, avg ${workerStats.copilot.avgScore}/100`
      : 'not started';
    const cloudflareStats = workerStats.cloudflare.count > 0 
      ? `${workerStats.cloudflare.count} articles, avg ${workerStats.cloudflare.avgScore}/100`
      : 'not started';
    
    console.log(`\n${colors.cyan}${'═'.repeat(70)}${colors.reset}`);
    console.log(`${colors.bold}📊 HEARTBEAT${colors.reset} ${statusColor}${colors.bold}${statusText}${colors.reset} ${colors.dim}${new Date().toLocaleTimeString()}${colors.reset}`);
    console.log(`${colors.cyan}${'─'.repeat(70)}${colors.reset}`);
    console.log(`   ${colors.green}📈 Progress:${colors.reset}    ${colors.bold}${progress}${colors.reset} ${colors.dim}(${percent}%)${colors.reset}`);
    console.log(`   ${colors.yellow}⚡ Rate:${colors.reset}        ${colors.bold}${rate}${colors.reset} articles/min (2 workers)`);
    console.log(`   ${colors.magenta}🎯 Avg SEO:${colors.reset}     ${avgScore > 0 ? coloredScore(avgScore) : colors.dim + 'waiting...' + colors.reset}`);
    console.log(`   ${colors.blue}📋 Pending:${colors.reset}     ${colors.bold}${stats.pending}${colors.reset} keywords left`);
    console.log(`   ${colors.cyan}🔗 Last:${colors.reset}        ${lastUrl}`);
    console.log(`${colors.cyan}${'─'.repeat(70)}${colors.reset}`);
    console.log(`   ${colors.bold}🤖 Worker Stats (A/B Test):${colors.reset}`);
    console.log(`      ${colors.yellow}Copilot:${colors.reset}    ${copilotStats}`);
    console.log(`      ${colors.green}Cloudflare:${colors.reset} ${cloudflareStats} ${colors.dim}(FREE)${colors.reset}`);
    console.log(`${colors.cyan}${'═'.repeat(70)}${colors.reset}\n`);
    
    // Reset counters for next minute
    articlesThisMinute = 0;
    recentSeoScores = [];
    lastHeartbeatTime = Date.now();
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function recordArticleGenerated(seoScore: number, slug?: string) {
  articlesThisMinute++;
  if (seoScore > 0) {
    recentSeoScores.push(seoScore);
  }
  if (slug) {
    lastGeneratedSlug = slug;
  }
}

// Color-coded log for successful article generation
function logSuccess(title: string, slug: string, seoScore: number, wordCount: number, model: string = 'gpt-4.1') {
  const url = `https://catsluvus.com/petinsurance/${slug}`;
  console.log(`\n${colors.bgGreen}${colors.bold} ✅ [COPILOT CLI] ${model} ${colors.reset}`);
  console.log(`   ${colors.bold}Title:${colors.reset} ${title}`);
  console.log(`   ${colors.bold}SEO Score:${colors.reset} ${coloredScore(seoScore)}`);
  console.log(`   ${colors.bold}Words:${colors.reset} ${wordCount}`);
  console.log(`   ${colors.bold}URL:${colors.reset} ${hyperlink(url)}`);
  console.log('');
}

// ============================================================================
// V3 RESEARCH PHASE ENDPOINTS
// Research must complete before generation can start
// Agent makes ALL strategic decisions - infrastructure executes them
// ============================================================================

/**
 * Start research phase - agent discovers niche, keywords, and monetization strategy
 */
router.post('/research/start', async (req: Request, res: Response) => {
  try {
    if (researchPhaseStatus === 'discovering' || researchPhaseStatus === 'analyzing') {
      return res.json({
        success: false,
        message: 'Research phase already in progress',
        status: researchPhaseStatus
      });
    }

    const { vertical, excludeCategories, minCPC, minVolume } = req.body;

    researchEngine = createResearchEngine();
    researchPhaseStatus = 'discovering';
    researchPhaseOutput = createEmptyResearchPhaseOutput();
    researchPhaseOutput.status = 'discovering';
    researchPhaseOutput.startedAt = new Date().toISOString();

    addActivityLog('info', 'Research phase STARTED - agent discovering niches', {
      vertical: vertical || 'cat/pet',
      excludeCategories: excludeCategories || ['petinsurance']
    });

    const prompt = researchEngine.getDiscoverNichesPrompt({
      vertical,
      excludeCategories: excludeCategories || ['petinsurance'],
      minCPC: minCPC || 2,
      minVolume: minVolume || 500
    });

    res.json({
      success: true,
      status: 'discovering',
      message: 'Research phase started - agent will discover profitable niches',
      prompt: prompt,
      nextStep: 'Use /research/submit-discovery to submit agent findings'
    });
  } catch (error: any) {
    researchPhaseStatus = 'error';
    addActivityLog('error', 'Research phase failed to start', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Submit niche discovery results from agent
 */
router.post('/research/submit-discovery', async (req: Request, res: Response) => {
  try {
    if (!researchEngine || !researchPhaseOutput) {
      return res.status(400).json({ error: 'Research phase not started. Call /research/start first.' });
    }

    if (researchPhaseStatus !== 'discovering') {
      return res.status(400).json({
        error: `Invalid state: expected 'discovering', got '${researchPhaseStatus}'`,
        currentStatus: researchPhaseStatus,
        hint: researchPhaseStatus === 'idle' ? 'Call /research/start first' : 'Already past discovery phase'
      });
    }

    const { discoveryResponse } = req.body;
    if (!discoveryResponse) {
      return res.status(400).json({ error: 'Missing discoveryResponse in request body' });
    }

    const parsed = researchEngine.parseAgentResponse<any>(discoveryResponse);
    if (!parsed) {
      return res.status(400).json({ error: 'Failed to parse agent response', progress: researchEngine.getProgress() });
    }

    if (parsed.selectedNiche) {
      researchPhaseOutput.nicheDiscovery = {
        vertical: 'cat/pet',
        niche: parsed.selectedNiche.name,
        reasoning: parsed.selectedNiche.reasoning,
        marketSize: parsed.selectedNiche.marketSize || '',
        competitorCount: parsed.selectedNiche.topCompetitors?.length || 0,
        topCompetitors: parsed.selectedNiche.topCompetitors || []
      };
    }

    researchPhaseStatus = 'analyzing';
    researchPhaseOutput.status = 'analyzing';

    const analyzePrompt = researchEngine.getAnalyzeNichePrompt(
      researchPhaseOutput.nicheDiscovery.niche,
      researchPhaseOutput.nicheDiscovery.topCompetitors
    );

    addActivityLog('info', `Niche selected: ${researchPhaseOutput.nicheDiscovery.niche}`, {
      reasoning: researchPhaseOutput.nicheDiscovery.reasoning
    });

    res.json({
      success: true,
      status: 'analyzing',
      selectedNiche: researchPhaseOutput.nicheDiscovery,
      prompt: analyzePrompt,
      nextStep: 'Use /research/submit-analysis to submit detailed analysis'
    });
  } catch (error: any) {
    researchPhaseStatus = 'error';
    res.status(500).json({ error: error.message });
  }
});

/**
 * Submit niche analysis results from agent
 */
router.post('/research/submit-analysis', async (req: Request, res: Response) => {
  try {
    if (!researchEngine || !researchPhaseOutput) {
      return res.status(400).json({ error: 'Research phase not started' });
    }

    if (researchPhaseStatus !== 'analyzing') {
      return res.status(400).json({
        error: `Invalid state: expected 'analyzing', got '${researchPhaseStatus}'`,
        currentStatus: researchPhaseStatus,
        hint: researchPhaseStatus === 'discovering' ? 'Submit discovery first via /research/submit-discovery' : 'State mismatch'
      });
    }

    const { analysisResponse } = req.body;
    if (!analysisResponse) {
      return res.status(400).json({ error: 'Missing analysisResponse in request body' });
    }

    const parsed = researchEngine.parseAgentResponse<any>(analysisResponse);
    if (!parsed) {
      return res.status(400).json({ error: 'Failed to parse analysis response' });
    }

    if (parsed.keywordClusters) {
      researchPhaseOutput.keywordResearch.clusters = parsed.keywordClusters;
    }

    if (parsed.competitorAnalysis) {
      researchPhaseOutput.competitorAnalysis = parsed.competitorAnalysis;
    }

    if (parsed.affiliatePrograms) {
      researchPhaseOutput.monetization.affiliatePrograms = parsed.affiliatePrograms;
    }

    if (parsed.recommendedAuthors) {
      (researchPhaseOutput as any).recommendedAuthors = parsed.recommendedAuthors;
    }

    if (parsed.nicheAnalysis) {
      if (parsed.nicheAnalysis.growthTrend) {
        (researchPhaseOutput as any).growthTrend = parsed.nicheAnalysis.growthTrend;
      }
      if (parsed.nicheAnalysis.competitionLevel) {
        (researchPhaseOutput as any).competitionLevel = parsed.nicheAnalysis.competitionLevel;
      }
    }

    researchPhaseStatus = 'prioritizing';
    researchPhaseOutput.status = 'prioritizing';

    const keywordPrompt = researchEngine.getExtractKeywordsPrompt(
      researchPhaseOutput.nicheDiscovery.niche,
      researchPhaseOutput.keywordResearch.clusters
    );

    addActivityLog('info', 'Niche analysis complete - extracting keywords', {
      clusters: researchPhaseOutput.keywordResearch.clusters.length,
      affiliatePrograms: researchPhaseOutput.monetization.affiliatePrograms.length
    });

    res.json({
      success: true,
      status: 'prioritizing',
      analysis: {
        clusters: researchPhaseOutput.keywordResearch.clusters,
        competitorGaps: researchPhaseOutput.competitorAnalysis.gaps,
        affiliatePrograms: researchPhaseOutput.monetization.affiliatePrograms
      },
      prompt: keywordPrompt,
      nextStep: 'Use /research/submit-keywords to submit keyword list'
    });
  } catch (error: any) {
    researchPhaseStatus = 'error';
    res.status(500).json({ error: error.message });
  }
});

/**
 * Submit keywords from agent and finalize CategoryContext
 */
router.post('/research/submit-keywords', async (req: Request, res: Response) => {
  try {
    if (!researchEngine || !researchPhaseOutput) {
      return res.status(400).json({ error: 'Research phase not started' });
    }

    if (researchPhaseStatus !== 'prioritizing') {
      return res.status(400).json({
        error: `Invalid state: expected 'prioritizing', got '${researchPhaseStatus}'`,
        currentStatus: researchPhaseStatus,
        hint: researchPhaseStatus === 'analyzing' ? 'Submit analysis first via /research/submit-analysis' : 'State mismatch'
      });
    }

    const { keywordsResponse, domain } = req.body;
    if (!keywordsResponse) {
      return res.status(400).json({ error: 'Missing keywordsResponse in request body' });
    }

    const parsed = researchEngine.parseAgentResponse<any>(keywordsResponse);
    if (!parsed || !parsed.keywords) {
      return res.status(400).json({ error: 'Failed to parse keywords response' });
    }

    researchPhaseOutput.keywordResearch.topKeywords = parsed.keywords;
    researchPhaseOutput.keywordResearch.totalKeywords = parsed.keywords.length;

    if (parsed.summary) {
      researchPhaseOutput.keywordResearch.avgCPC = parsed.summary.averageCPC || 0;
      researchPhaseOutput.keywordResearch.avgVolume = parsed.summary.totalMonthlyVolume / parsed.summary.totalKeywords || 0;
    }

    const categorySlug = researchPhaseOutput.nicheDiscovery.niche.toLowerCase().replace(/\s+/g, '-');
    researchPhaseOutput.targetStructure = {
      domain: domain || 'catsluvus.com',
      basePath: `/${categorySlug}`,
      slugFormat: `/${categorySlug}/{keyword-slug}`,
      sitemapPath: `/${categorySlug}/sitemap.xml`,
      kvPrefix: `${categorySlug}:`
    };

    activeCategoryContext = researchEngine.outputCategoryContext(researchPhaseOutput, domain);
    researchPhaseOutput.categoryContext = activeCategoryContext;

    researchPhaseStatus = 'complete';
    researchPhaseOutput.status = 'complete';
    researchPhaseOutput.completedAt = new Date().toISOString();

    const kvResult = await saveResearchToKV(researchPhaseOutput, activeCategoryContext);
    if (!kvResult.success) {
      addActivityLog('error', `Failed to persist research to KV: ${kvResult.error}`, {});
    } else {
      addActivityLog('info', `Research persisted to KV: ${activeCategoryContext.kvPrefix}`, {});
    }

    // AUTO-CONFIGURE CLOUDFLARE WORKER ROUTE for this category
    // This ensures the public domain routes /{category}/* to the Worker
    const categorySlugForRoute = activeCategoryContext.basePath?.replace(/^\//, '') || categorySlug;
    console.log(`[SEO-V3] Configuring Worker Route for new category: ${categorySlugForRoute}`);
    const routeResult = await ensureWorkerRouteForCategory(categorySlugForRoute);
    if (routeResult.success) {
      addActivityLog('info', `Worker Route configured: catsluvus.com/${categorySlugForRoute}/*`, {
        routeId: routeResult.routeId
      });
    } else {
      addActivityLog('warning', `Worker Route config failed: ${routeResult.error}`, {});
    }

    addActivityLog('info', 'Research phase COMPLETE - CategoryContext ready', {
      category: activeCategoryContext.categoryName,
      keywords: activeCategoryContext.keywords.length,
      basePath: activeCategoryContext.basePath
    });

    res.json({
      success: true,
      status: 'complete',
      categoryContext: activeCategoryContext,
      kvPersisted: kvResult.success,
      message: 'Research complete. Use /autonomous/start to begin generation with this category.'
    });
  } catch (error: any) {
    researchPhaseStatus = 'error';
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get current research phase status
 */
router.get('/research/status', async (req: Request, res: Response) => {
  const attemptRecovery = req.query.recover === 'true';
  const kvPrefix = req.query.kvPrefix as string;

  if (attemptRecovery && kvPrefix && !activeCategoryContext) {
    const recovered = await loadResearchFromKV(kvPrefix);
    if (recovered.categoryContext) {
      activeCategoryContext = recovered.categoryContext;
      researchPhaseOutput = recovered.researchOutput;
      researchPhaseStatus = 'complete';
      addActivityLog('info', `Recovered research from KV: ${kvPrefix}`, {});
    }
  }

  res.json({
    status: researchPhaseStatus,
    hasResearchEngine: !!researchEngine,
    hasOutput: !!researchPhaseOutput,
    hasCategoryContext: !!activeCategoryContext,
    output: researchPhaseOutput ? {
      id: researchPhaseOutput.id,
      niche: researchPhaseOutput.nicheDiscovery?.niche,
      keywordCount: researchPhaseOutput.keywordResearch?.totalKeywords,
      status: researchPhaseOutput.status
    } : null,
    categoryContext: activeCategoryContext ? {
      categoryName: activeCategoryContext.categoryName,
      basePath: activeCategoryContext.basePath,
      keywordCount: activeCategoryContext.keywords.length,
      kvPrefix: activeCategoryContext.kvPrefix
    } : null
  });
});

/**
 * Reset research phase to start fresh
 */
router.post('/research/reset', async (_req: Request, res: Response) => {
  researchEngine = null;
  researchPhaseOutput = null;
  activeCategoryContext = null;
  researchPhaseStatus = 'idle';

  addActivityLog('info', 'Research phase RESET');

  res.json({
    success: true,
    status: 'idle',
    message: 'Research phase reset. Call /research/start to begin new research.'
  });
});

/**
 * Get CategoryContext for use in generation
 */
router.get('/research/context', async (_req: Request, res: Response) => {
  if (!activeCategoryContext) {
    return res.status(404).json({
      error: 'No CategoryContext available. Complete research phase first.'
    });
  }

  res.json(activeCategoryContext);
});

// ============================================================================
// AUTONOMOUS GENERATION ENDPOINTS
// ============================================================================

/**
 * Start autonomous generation mode
 * Runs as fast as possible with no delay - rate limits handle throttling naturally
 */
router.post('/autonomous/start', async (req: Request, res: Response) => {
  if (autonomousRunning) {
    addActivityLog('info', 'Autonomous mode already running');
    return res.json({ running: true, message: 'Already running' });
  }

  autonomousRunning = true;
  startHeartbeat();

  addActivityLog('info', `Autonomous mode STARTED (NO DELAY - max speed)`, {
    remaining: stats.pending
  });

  // Start continuous generation - no interval, runs as fast as possible
  generateNextArticle();

  res.json({
    success: true,
    running: true,
    mode: 'max-speed',
    message: 'Autonomous generation started (no delay - max speed)'
  });
});

/**
 * Stop autonomous generation
 */
router.post('/autonomous/stop', async (_req: Request, res: Response) => {
  autonomousRunning = false;
  stopHeartbeat();

  addActivityLog('info', 'Autonomous mode STOPPED', {
    remaining: stats.pending,
    queuePosition: stats.generated
  });

  res.json({
    success: true,
    running: false,
    message: 'Autonomous generation stopped'
  });
});

/**
 * Get autonomous status with queue information
 */
router.get('/autonomous/status', async (_req: Request, res: Response) => {
  try {
    const queueStatus = await getGenerationQueueStatus();

    res.json({
      running: autonomousRunning,
      generated: queueStatus.generated,
      remaining: queueStatus.remaining,
      totalKeywords: queueStatus.totalKeywords,
      percentComplete: queueStatus.percentComplete,
      pendingByPriority: queueStatus.topPending,
      nextKeyword: queueStatus.nextKeyword ? {
        keyword: queueStatus.nextKeyword.keyword,
        slug: queueStatus.nextKeyword.slug,
        priority: queueStatus.nextKeyword.priority,
        score: queueStatus.nextKeyword.score,
        category: queueStatus.nextKeyword.category
      } : null
    });
  } catch (error: any) {
    res.json({
      running: autonomousRunning,
      generated: stats.generated,
      pending: stats.pending,
      percentComplete: stats.percentComplete,
      error: error.message
    });
  }
});

/**
 * Manually create Cloudflare Worker routes for a category
 * Used when auto-creation fails or to verify routes exist
 */
router.post('/create-route', async (req: Request, res: Response) => {
  try {
    const { category } = req.body;
    if (!category) {
      return res.status(400).json({ error: 'Category is required' });
    }

    addActivityLog('info', `Manual route creation requested for: ${category}`);
    
    const result = await ensureWorkerRouteForCategory(category);
    
    if (result.success) {
      addActivityLog('success', `Worker route created/verified for: ${category}`, { routeId: result.routeId });
      return res.json({ 
        success: true, 
        category,
        routeId: result.routeId,
        message: `Worker routes configured for ${category}` 
      });
    } else {
      addActivityLog('error', `Route creation failed for ${category}: ${result.error}`);
      return res.status(500).json({ 
        success: false, 
        category,
        error: result.error 
      });
    }
  } catch (error: any) {
    addActivityLog('error', `Route creation error: ${error.message}`);
    return res.status(500).json({ error: error.message });
  }
});

/**
 * Manually trigger category discovery (for testing)
 */
router.post('/discover-category', async (_req: Request, res: Response) => {
  try {
    addActivityLog('info', '[V3] Manual category discovery triggered');
    const category = await discoverNextCategory();
    if (category) {
      res.json({ success: true, category });
    } else {
      res.json({ success: false, message: 'No categories available' });
    }
  } catch (error: any) {
    addActivityLog('error', `[V3] Discovery error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Manually start a new category with keywords
 */
router.post('/start-category', async (req: Request, res: Response) => {
  try {
    const { slug, name, keywords } = req.body;
    if (!slug) {
      return res.status(400).json({ error: 'slug is required' });
    }

    addActivityLog('info', `[V3] Manual category start: ${slug}`);
    
    // Create Worker routes
    const routeResult = await ensureWorkerRouteForCategory(slug);
    if (!routeResult.success) {
      addActivityLog('warning', `[V3] Route creation warning: ${routeResult.error}`);
    }
    
    // If no keywords provided, generate them
    let categoryKeywords = keywords;
    if (!categoryKeywords || categoryKeywords.length === 0) {
      const discovered: DiscoveredCategory = {
        name: name || slug,
        slug: slug,
        estimatedKeywords: 30,
        affiliatePotential: 'medium',
        reasoning: 'Manually started category'
      };
      categoryKeywords = await generateCategoryKeywords(discovered);
    }
    
    if (categoryKeywords.length < 5) {
      return res.status(400).json({ error: `Only ${categoryKeywords.length} keywords generated, need at least 5` });
    }
    
    // Save in-progress status
    await saveCategoryStatus(slug, {
      category: slug,
      status: 'in_progress',
      articleCount: 0,
      expectedCount: categoryKeywords.length,
      avgSeoScore: 0,
      startedAt: new Date().toISOString()
    });
    
    addActivityLog('success', `[V3] Category initialized: ${slug}`, {
      keywords: categoryKeywords.length,
      routeCreated: routeResult.success
    });
    
    res.json({ 
      success: true, 
      category: slug, 
      keywords: categoryKeywords.length,
      routeCreated: routeResult.success,
      message: 'Category routes and status created. To start generation, use the V3 autonomous flow.'
    });
  } catch (error: any) {
    addActivityLog('error', `[V3] Start category error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get category status
 */
router.get('/category-status/:category', async (req: Request, res: Response) => {
  try {
    const { category } = req.params;
    const status = await getCategoryStatus(category);
    const articleCount = await countArticlesInCategory(category);
    
    res.json({
      category,
      status: status || { status: 'unknown' },
      actualArticleCount: articleCount
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * List all completed categories
 */
router.get('/completed-categories', async (_req: Request, res: Response) => {
  try {
    const completed = await getCompletedCategories();
    res.json({ completed, count: completed.length });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get detailed generation queue with priority breakdown
 */
router.get('/queue', async (_req: Request, res: Response) => {
  try {
    const queueStatus = await getGenerationQueueStatus();
    const priorityStats = getPriorityStats();
    const topKeywords = getTopKeywords(5);

    // Get top pending keywords for each priority
    const existingSlugs = await fetchExistingArticleSlugs();
    const pendingHigh = topKeywords.high.filter(k => !existingSlugs.has(k.slug));
    const pendingMedium = topKeywords.medium.filter(k => !existingSlugs.has(k.slug));
    const pendingLow = topKeywords.low.filter(k => !existingSlugs.has(k.slug));

    res.json({
      status: 'ok',
      queue: {
        totalKeywords: queueStatus.totalKeywords,
        generated: queueStatus.generated,
        remaining: queueStatus.remaining,
        percentComplete: queueStatus.percentComplete
      },
      priorityBreakdown: {
        total: priorityStats.byPriority,
        pending: queueStatus.topPending
      },
      categoryBreakdown: priorityStats.byCategory,
      nextToGenerate: queueStatus.nextKeyword,
      samplePending: {
        high: pendingHigh.slice(0, 5).map(k => ({ keyword: k.keyword, score: k.score })),
        medium: pendingMedium.slice(0, 5).map(k => ({ keyword: k.keyword, score: k.score })),
        low: pendingLow.slice(0, 5).map(k => ({ keyword: k.keyword, score: k.score }))
      },
      autonomousRunning
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function for autonomous generation using Copilot SDK - NO FALLBACK
// Now uses prioritized keywords and duplicate tracking
async function generateNextArticle() {
  if (!autonomousRunning) return;

  const startTime = Date.now();

  try {
    // Get next prioritized keyword that hasn't been generated
    addActivityLog('queue', 'Fetching next prioritized keyword from queue...');
    const nextKw = await getNextPrioritizedKeyword();

    if (!nextKw) {
      addActivityLog('success', '[V1] All keywords have been generated! Pet Insurance queue complete.', {
        remaining: 0
      });
      console.log('✅ [V1] All Pet Insurance keywords have been generated! Stopping autonomous mode.');
      autonomousRunning = false;
      return;
    }

    const { keyword, slug, priority, score, category } = nextKw;

    // Note: Keyword is already locked in keywordsInProgress by getNextPrioritizedKeyword()

    // Double-check the article doesn't already exist (race condition protection)
    if (await articleExists(slug)) {
      keywordsInProgress.delete(slug); // Release the lock
      addActivityLog('info', `Skipping duplicate: "${keyword}"`, { keyword, slug, priority });
      console.log(`⏭️ Skipping "${keyword}" - already exists in KV`);
      // Invalidate cache and try next keyword
      slugsCacheTime = 0;
      setTimeout(generateNextArticle, 1000); // Try next keyword after 1 second
      return;
    }

    // Log the start of generation
    addActivityLog('generating', `Starting generation: "${keyword}"`, {
      keyword,
      slug,
      priority,
      score,
      remaining: stats.pending
    });

    console.log(`🤖 Autonomous: Generating [${priority.toUpperCase()}] "${keyword}" (score: ${score}, category: ${category})`);

    // Start a heartbeat timer to show progress during generation
    let elapsed = 0;
    const heartbeatInterval = setInterval(() => {
      elapsed += 15;
      addActivityLog('info', `⏳ Generating... (${elapsed}s elapsed)`, {
        keyword,
        slug,
        priority
      });
    }, 15000); // Log every 15 seconds

    let result;
    try {
      result = await generateWithCopilotSDK(keyword);
    } finally {
      clearInterval(heartbeatInterval);
    }

    if (!result.success) {
      keywordsInProgress.delete(slug); // Release the lock on failure
      if (result.error?.includes('No model available') || result.error?.includes('policy enablement')) {
        addActivityLog('error', 'STOPPED: GitHub Copilot not enabled', {
          keyword,
          slug
        });
        console.error('❌ Autonomous STOPPED: GitHub Copilot not enabled at https://github.com/settings/copilot');
        autonomousRunning = false;
        return;
      }
      addActivityLog('error', `Generation failed: ${result.error}`, {
        keyword,
        slug,
        priority
      });
      console.error(`❌ Autonomous error: ${result.error}`);
      // Continue to next article on non-fatal errors
      if (autonomousRunning) {
        setTimeout(generateNextArticle, 5000);
      }
      return;
    }

    const duration = Date.now() - startTime;

    // Add to local cache immediately to prevent duplicates
    existingArticleSlugs.add(slug);
    registerArticleForLinking(slug, 'petinsurance');
    // Remove from in-progress (now complete)
    keywordsInProgress.delete(slug);

    // Update stats from queue status
    const queueStatus = await getGenerationQueueStatus();
    stats.generated = queueStatus.generated;
    stats.pending = queueStatus.remaining;
    stats.percentComplete = queueStatus.percentComplete;

    // Store in recent articles
    const articleData = {
      keyword,
      slug,
      title: result.article!.title,
      wordCount: result.article!.wordCount || 3500,
      date: new Date().toISOString(),
      deployed: result.deployed || false,
      liveUrl: result.liveUrl || null,
      priority,
      score,
      category
    };
    recentArticles.unshift(articleData as any);
    recentArticles = recentArticles.slice(0, 50);

    // Log successful generation with SEO score
    const articleSeoScore = (result as any).seoScore || 0;
    const articleWordCount = result.article!.wordCount || 3500;
    
    // Record for heartbeat stats (with slug for last URL display)
    recordArticleGenerated(articleSeoScore, slug);
    
    // Color-coded success log with clickable URL
    logSuccess(result.article!.title, slug, articleSeoScore, articleWordCount);
    
    addActivityLog('success', `Generated: "${result.article!.title}" | SEO: ${articleSeoScore}/100`, {
      keyword,
      slug,
      priority,
      score,
      seoScore: articleSeoScore,
      wordCount: articleWordCount,
      duration,
      remaining: stats.pending
    });

    // Log deployment status
    if (result.deployed) {
      const liveUrl = result.liveUrl || `https://catsluvus.com/petinsurance/${slug}`;
      addActivityLog('deployed', `Deployed to Cloudflare KV`, {
        keyword,
        slug,
        url: liveUrl
      });

      // DataForSEO On-Page scoring (async, non-blocking, 10s delay for CDN propagation)
      getOnPageScoreWithRetry(liveUrl, 2, 10000).then(dfsScore => {
        if (dfsScore) {
          const categorized = categorizeSEOIssues(dfsScore.issues);
          const fixableCount = categorized.fixable.length;
          const infoCount = categorized.informational.length;
          console.log(`[DataForSEO] ${slug}: ${dfsScore.overallScore}/100 (${dfsScore.checks.passed} passed, ${dfsScore.checks.failed} failed) | Fixable: ${fixableCount}, Infrastructure: ${infoCount}`);
          addActivityLog('seo-score', `[DataForSEO] Professional SEO: ${dfsScore.overallScore}/100`, {
            keyword,
            slug,
            dataForSEOScore: dfsScore.overallScore,
            passed: dfsScore.checks.passed,
            failed: dfsScore.checks.failed,
            fixableIssues: categorized.fixable.join(', ') || 'none',
            infrastructureIssues: categorized.informational.join(', ') || 'none'
          });
        }
      }).catch(() => {});
    }

    // Log progress update
    addActivityLog('queue', `Progress: ${stats.generated}/${ALL_KEYWORDS.length} (${stats.percentComplete}%)`, {
      remaining: stats.pending,
      queuePosition: stats.generated
    });

    // Immediately start next article (no delay - max speed mode)
    if (autonomousRunning) {
      setImmediate(generateNextArticle);
    }

  } catch (error: any) {
    addActivityLog('error', `Error: ${error.message}`);
    console.error('❌ Autonomous error:', error.message);
    
    // On error, wait 5 seconds before retrying (rate limit backoff)
    if (autonomousRunning) {
      setTimeout(generateNextArticle, 5000);
    }
  }
}

// Worker 2: Cloudflare AI worker - runs in parallel with Copilot (replaced unreliable OpenRouter)
let cloudflareWorkerRunning = false;

async function generateNextArticleCloudflare() {
  if (!autonomousRunning || !cloudflareWorkerRunning) return;

  const startTime = Date.now();

  try {
    // Get next prioritized keyword (different from the one Copilot is working on)
    const nextKw = await getNextPrioritizedKeyword();

    if (!nextKw) {
      console.log('[Cloudflare AI] No more keywords, pausing...');
      setTimeout(generateNextArticleCloudflare, 30000);
      return;
    }

    const { keyword, slug, priority, score, category } = nextKw;

    // Note: Keyword is already locked in keywordsInProgress by getNextPrioritizedKeyword()

    // Double-check the article doesn't already exist
    if (await articleExists(slug)) {
      keywordsInProgress.delete(slug); // Release the lock
      console.log(`⏭️ [Cloudflare AI] Skipping "${keyword}" - already exists`);
      slugsCacheTime = 0;
      setTimeout(generateNextArticleCloudflare, 1000);
      return;
    }

    console.log(`☁️ Cloudflare AI Worker: Generating [${priority.toUpperCase()}] "${keyword}" (score: ${score})`);

    let result;
    try {
      result = await generateWithCloudflareAI_SDK(keyword);
    } catch (err: any) {
      keywordsInProgress.delete(slug); // Release the lock on error
      console.error(`❌ [Cloudflare AI] Error: ${err.message}`);
      if (autonomousRunning && cloudflareWorkerRunning) {
        setTimeout(generateNextArticleCloudflare, 10000);
      }
      return;
    }

    if (!result.success) {
      keywordsInProgress.delete(slug); // Release the lock on failure
      console.error(`❌ [Cloudflare AI] Failed: ${result.error}`);
      if (autonomousRunning && cloudflareWorkerRunning) {
        setTimeout(generateNextArticleCloudflare, 10000);
      }
      return;
    }

    const duration = Date.now() - startTime;

    // Add to local cache immediately
    existingArticleSlugs.add(slug);
    registerArticleForLinking(slug, 'petinsurance');
    // Remove from in-progress (now complete)
    keywordsInProgress.delete(slug);

    // Update stats
    const queueStatus = await getGenerationQueueStatus();
    stats.generated = queueStatus.generated;
    stats.pending = queueStatus.remaining;
    stats.percentComplete = queueStatus.percentComplete;

    // Store in recent articles
    const articleData = {
      keyword,
      slug,
      title: result.article!.title,
      wordCount: result.article!.wordCount || 3500,
      date: new Date().toISOString(),
      deployed: result.deployed || false,
      liveUrl: result.liveUrl || null,
      priority,
      score,
      category,
      worker: 'cloudflare'
    };
    recentArticles.unshift(articleData as any);
    recentArticles = recentArticles.slice(0, 50);

    const articleSeoScore = (result as any).seoScore || 0;
    const articleWordCount = result.article!.wordCount || 3500;
    
    recordArticleGenerated(articleSeoScore, slug);
    
    // Log with Cloudflare AI branding - show model used
    const modelUsed = result.model || 'llama-4-scout-17b-16e-instruct';
    console.log(`\n${colors.bgCyan}${colors.bold} ☁️ [CLOUDFLARE AI] ${modelUsed} ${colors.reset}`);
    console.log(`   ${colors.bold}Title:${colors.reset} ${result.article!.title}`);
    console.log(`   ${colors.bold}SEO Score:${colors.reset} ${coloredScore(articleSeoScore)}`);
    console.log(`   ${colors.bold}Words:${colors.reset} ${articleWordCount}`);
    console.log(`   ${colors.bold}URL:${colors.reset} ${hyperlink(`https://catsluvus.com/petinsurance/${slug}`)}`);
    console.log(`   ${colors.dim}(FREE - Cloudflare Workers AI)${colors.reset}\n`);

    addActivityLog('success', `[Cloudflare AI] Generated: "${result.article!.title}" | SEO: ${articleSeoScore}/100`, {
      keyword,
      slug,
      priority,
      score,
      seoScore: articleSeoScore,
      wordCount: articleWordCount,
      duration,
      remaining: stats.pending
    });

    // DataForSEO On-Page scoring (async, non-blocking, 10s delay for CDN propagation)
    const cfLiveUrl = `https://catsluvus.com/petinsurance/${slug}`;
    getOnPageScoreWithRetry(cfLiveUrl, 2, 10000).then(dfsScore => {
      if (dfsScore) {
        const categorized = categorizeSEOIssues(dfsScore.issues);
        const fixableCount = categorized.fixable.length;
        const infoCount = categorized.informational.length;
        console.log(`[DataForSEO] ${slug}: ${dfsScore.overallScore}/100 (${dfsScore.checks.passed} passed, ${dfsScore.checks.failed} failed) | Fixable: ${fixableCount}, Infrastructure: ${infoCount}`);
        addActivityLog('seo-score', `[DataForSEO] Professional SEO: ${dfsScore.overallScore}/100`, {
          keyword,
          slug,
          dataForSEOScore: dfsScore.overallScore,
          passed: dfsScore.checks.passed,
          failed: dfsScore.checks.failed,
          fixableIssues: categorized.fixable.join(', ') || 'none',
          infrastructureIssues: categorized.informational.join(', ') || 'none'
        });
      }
    }).catch(() => {});

    // Continue immediately
    if (autonomousRunning && cloudflareWorkerRunning) {
      setImmediate(generateNextArticleCloudflare);
    }

  } catch (error: any) {
    console.error('❌ [Cloudflare AI] Error:', error.message);
    
    if (autonomousRunning && cloudflareWorkerRunning) {
      setTimeout(generateNextArticleCloudflare, 10000);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// V3 AUTONOMOUS RESEARCH & GENERATION
// Fully autonomous pipeline: Research → CategoryContext → Content Generation
// ═══════════════════════════════════════════════════════════════════════════

let v3AutonomousRunning = false;
let v3CategoryContext: CategoryContext | null = null;

async function runV3AutonomousResearch(): Promise<CategoryContext | null> {
  console.log('[SEO-V3] 🚀 Starting autonomous research phase...');
  addActivityLog('info', '[V3] Starting autonomous research - agent will discover new category');

  try {
    const engine = ResearchEngine.createForResearch();
    
    // Phase 1: Niche Discovery
    console.log('[SEO-V3] Phase 1: Niche Discovery...');
    const discoveryPrompt = engine.getNicheDiscoveryPrompt({
      vertical: 'cat/pet',
      excludeCategories: ['pet insurance', 'cat insurance'],
      minCPC: 1.0,
      minVolume: 500
    });

    const discoveryResponse = await generateWithCopilotCLI(discoveryPrompt, 300000);
    const discoveryJson = engine.parseAgentResponse<any>(discoveryResponse);
    
    // Handle both object and string formats for selectedNiche
    const selectedNiche = typeof discoveryJson?.selectedNiche === 'object' 
      ? discoveryJson.selectedNiche?.name || discoveryJson.selectedNiche?.niche || JSON.stringify(discoveryJson.selectedNiche)
      : discoveryJson?.selectedNiche;
    
    if (!selectedNiche) {
      throw new Error('Agent did not select a niche');
    }

    console.log(`[SEO-V3] ✅ Agent selected niche: "${selectedNiche}"`);
    addActivityLog('info', `[V3] Agent discovered niche: ${selectedNiche}`, {
      reasoning: discoveryJson.reasoning || discoveryJson.selectedNiche?.reasoning,
      marketSize: discoveryJson.marketSizeEstimate || discoveryJson.selectedNiche?.marketSize
    });

    // Phase 2: Niche Analysis
    console.log('[SEO-V3] Phase 2: Deep Niche Analysis...');
    const analysisPrompt = engine.getNicheAnalysisPrompt(
      selectedNiche,
      discoveryJson.keywordSeeds || []
    );

    const analysisResponse = await generateWithCopilotCLI(analysisPrompt, 300000);
    const analysisJson = engine.parseAgentResponse<any>(analysisResponse);

    if (!analysisJson?.keywordClusters) {
      throw new Error('Agent did not provide keyword clusters');
    }

    console.log(`[SEO-V3] ✅ Agent identified ${analysisJson.keywordClusters?.length || 0} keyword clusters`);

    // Phase 3: Keyword Extraction & Prioritization
    console.log('[SEO-V3] Phase 3: Keyword Prioritization...');
    const keywordPrompt = engine.getExtractKeywordsPrompt(
      selectedNiche,
      analysisJson.keywordClusters || []
    );

    const keywordResponse = await generateWithCopilotCLI(keywordPrompt, 300000);
    const keywordJson = engine.parseAgentResponse<any>(keywordResponse);

    // Handle multiple response formats: prioritizedKeywords, keywords, or topKeywords
    const extractedKeywords = keywordJson?.prioritizedKeywords || keywordJson?.keywords || keywordJson?.topKeywords || [];
    
    if (!extractedKeywords || extractedKeywords.length === 0) {
      console.log('[SEO-V3] ⚠️ No keywords extracted, using fallback keyword list');
      // Use discovered niche to generate basic keywords as fallback
    }

    console.log(`[SEO-V3] ✅ Agent prioritized ${extractedKeywords.length} keywords by revenue potential`);

    // Build slug from niche name
    const nicheSlug = selectedNiche.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    
    // Build ResearchPhaseOutput
    const researchOutput: ResearchPhaseOutput = {
      id: `v3-research-${Date.now()}`,
      status: 'complete',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      nicheDiscovery: {
        niche: selectedNiche,
        reasoning: discoveryJson.reasoning || discoveryJson.selectedNiche?.reasoning || '',
        marketSize: discoveryJson.marketSizeEstimate || discoveryJson.selectedNiche?.marketSize || '$1B+',
        growthRate: discoveryJson.growthRate || '10%',
        competitorCount: discoveryJson.competitorCount || 50
      },
      keywordResearch: {
        totalKeywords: extractedKeywords.length,
        avgCPC: 2.5,
        avgVolume: 1000,
        topKeywords: extractedKeywords.slice(0, 100).map((k: any, index: number) => ({
          keyword: k.keyword || k.name || k,
          slug: (k.keyword || k.name || k).toString().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
          volume: k.volume || 1000,
          cpc: k.cpc || k.breakdown?.cpcScore || 2.0,
          difficulty: k.difficulty || 50,
          intent: k.intent || 'informational' as const,
          priority: (k.recommendedOrder || index) <= 10 ? 'high' : (k.recommendedOrder || index) <= 30 ? 'medium' : 'low',
          status: 'pending' as const
        })),
        clusters: analysisJson.keywordClusters || []
      },
      competitorAnalysis: {
        topCompetitors: [],
        gaps: analysisJson.competitorGaps || analysisJson.competitorAnalysis?.gaps || [],
        opportunities: []
      },
      monetization: {
        affiliatePrograms: (analysisJson.affiliatePrograms || []).map((p: any) => ({
          name: p.name || p,
          commissionRate: p.commissionRate || 10,
          cookieDuration: p.cookieDuration || 30
        })),
        adPotential: 'high',
        revenueProjection: { month1: 500, month6: 3000, month12: 10000 }
      },
      targetStructure: {
        domain: 'catsluvus.com',
        basePath: `/${nicheSlug}`,
        slugFormat: `/${nicheSlug}/{keyword-slug}`,
        sitemapPath: `/${nicheSlug}/sitemap.xml`,
        kvPrefix: `${nicheSlug}:`
      }
    };

    // Store agent-provided metadata
    (researchOutput as any).recommendedAuthors = analysisJson.recommendedAuthors || [];
    (researchOutput as any).growthTrend = analysisJson.nicheAnalysis?.growthTrend || 'stable';
    (researchOutput as any).competitionLevel = analysisJson.nicheAnalysis?.competitionLevel || 'medium';

    // Generate CategoryContext
    const categoryContext = engine.outputCategoryContext(researchOutput, 'catsluvus.com');

    // Persist to KV
    await saveResearchToKV(researchOutput, categoryContext);

    console.log(`[SEO-V3] ✅ Research complete! Category: ${categoryContext.categoryName}`);
    console.log(`[SEO-V3] 📊 ${categoryContext.keywords.length} keywords ready for generation`);
    console.log(`[SEO-V3] 🔗 Base path: ${categoryContext.basePath}`);

    addActivityLog('success', `[V3] Research COMPLETE - ${categoryContext.categoryName}`, {
      keywords: categoryContext.keywords.length,
      basePath: categoryContext.basePath,
      kvPrefix: categoryContext.kvPrefix
    });

    return categoryContext;

  } catch (error: any) {
    console.error('[SEO-V3] ❌ Research failed:', error.message);
    addActivityLog('error', `[V3] Research failed: ${error.message}`);
    return null;
  }
}

async function generateV3Article(keyword: KeywordData, context: CategoryContext): Promise<boolean> {
  try {
    console.log(`[SEO-V3] 📝 Generating: "${keyword.keyword}"`);
    addActivityLog('generating', `[V3] Generating: "${keyword.keyword}"`, {
      keyword: keyword.keyword,
      priority: keyword.priority || 'medium',
      slug: keyword.slug
    });
    const slug = keyword.slug;

    // 1. SERP Analysis - Analyze what's ranking #1-10 to beat competitors
    console.log(`[SEO-V3] [Step 1/7] SERP analysis for: "${keyword.keyword}"`);
    const serpAnalysis = await analyzeSERP(keyword.keyword);
    console.log(`[SEO-V3] [Step 1/7] ✓ SERP complete (${serpAnalysis.topResults.length} results)`);
    
    // Build SERP insights for the prompt
    const competitorHeadingsText = serpAnalysis.competitorHeadings.length > 0
      ? `\nCompetitor H2/H3 headings (COVER ALL): ${serpAnalysis.competitorHeadings.slice(0, 12).join(' | ')}`
      : '';
    const competitorFAQsText = serpAnalysis.competitorFAQs.length > 0
      ? `\nCompetitor FAQ questions (ANSWER ALL): ${serpAnalysis.competitorFAQs.slice(0, 8).join(' | ')}`
      : '';
    const competitorEntitiesText = serpAnalysis.competitorEntities?.length > 0
      ? `\nKey entities/brands to reference: ${serpAnalysis.competitorEntities.slice(0, 10).join(', ')}`
      : '';

    const serpInsights = serpAnalysis.topResults.length > 0 
      ? `\n\nCOMPETITOR ANALYSIS (Top 10 Google results):
Top-ranking titles: ${serpAnalysis.topResults.slice(0, 5).map(r => `"${r.title}"`).join(', ')}
Topics ALL competitors cover: ${serpAnalysis.commonTopics.join(', ')}${competitorHeadingsText}${competitorFAQsText}${competitorEntitiesText}
Content gaps to exploit: ${serpAnalysis.contentGaps.join(', ')}
Target word count: ${serpAnalysis.targetWordCount}+ words\n`
      : '';

    // 2. Fetch People Also Ask questions
    console.log(`[SEO-V3] [Step 2/7] Fetching PAA questions...`);
    const paaQuestions = await fetchPAAQuestions(keyword.keyword);
    console.log(`[SEO-V3] [Step 2/7] ✓ PAA complete (${paaQuestions.length} questions)`);
    const paaQuestionsText = paaQuestions.length > 0 
      ? `\n\nPEOPLE ALSO ASK (Use as FAQs):\n${paaQuestions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')}\n`
      : '';

    // 3. Get existing articles for internal linking (BOTH same-category AND cross-category)
    console.log(`[SEO-V3] [Step 3/7] Fetching existing article slugs...`);
    const existingSlugs = await fetchExistingArticleSlugs(context.kvPrefix);
    console.log(`[SEO-V3] [Step 3/7] ✓ Found ${existingSlugs.length} same-category articles`);

    // Fetch cross-category articles (from V3-exclusive categories) with full URLs
    const crossCategoryUrls = await fetchCrossCategoryArticlesForLinking(context.kvPrefix);
    console.log(`[SEO-V3] [Step 3/7] ✓ Found ${crossCategoryUrls.length} cross-category articles for linking`);

    // Combine: same-category slugs (convert to full URLs) + cross-category URLs
    // Normalize basePath to ensure proper URL format: /category/ (with trailing slash)
    let categoryPath = context.basePath || `/${context.kvPrefix.replace(/:$/, '')}/`;
    // Ensure categoryPath ends with exactly one slash
    if (!categoryPath.endsWith('/')) categoryPath += '/';
    if (!categoryPath.startsWith('/')) categoryPath = '/' + categoryPath;

    const sameCategoryUrls = existingSlugs.slice(0, 20).map(slug => `${categoryPath}${slug}`);
    const allArticleUrls = [...sameCategoryUrls, ...crossCategoryUrls.slice(0, 30)];
    const existingArticlesList = allArticleUrls.join('\n');

    // 4. Fetch real Amazon products for comparison table
    console.log(`[SEO-V3] [Step 4/8] Fetching Amazon products...`);
    const amazonProducts = await fetchAmazonProductsForKeyword(keyword.keyword, 'Pet Supplies');
    console.log(`[SEO-V3] [Step 4/8] ✓ Amazon: ${amazonProducts.products.length} products found`);

    // 5. Get category-specific content data (brands, authors, FAQs, etc.)
    const categorySlug = context.categorySlug || context.niche || 'DEFAULT';
    const categoryContent = getCategoryContentData(categorySlug);
    console.log(`[SEO-V3] Using category content for: ${categorySlug}`);

    // 5. Build category-specific comparison table based on context entities or category defaults
    const contextEntities = context.entities || [];
    const comparisonBrands = contextEntities.length > 0 
      ? contextEntities.slice(0, 5).map(e => e.name).join(', ')
      : categoryContent.brands.join(', ');

    // 6. Build author info from context or category defaults
    const contextAuthors = context.authors || [];
    const expertAuthor = contextAuthors[0] || categoryContent.author;

    // 7. Build dynamic JSON template examples from category content
    const categoryImageExamples = categoryContent.imageAltTemplates.map((alt, i) => 
      `{"url": "https://images.unsplash.com/photo-category-${i + 1}?w=800&q=80", "alt": "${alt.replace('{keyword}', keyword.keyword)}", "caption": "${categoryContent.imageCaptions[i] || 'Expert guide image.'}"}`
    ).join(',\n    ');

    // Build comparison example with REAL Amazon products (if available) or instructions
    const amazonAffiliateTag = process.env.AMAZON_AFFILIATE_TAG || 'catsluvus03-20';
    let categoryComparisonExample: string;
    let amazonProductsPromptText = '';

    if (amazonProducts.products.length > 0) {
      // We have real Amazon products - use them directly
      amazonProductsPromptText = amazonProducts.promptText;
      categoryComparisonExample = `{
    "headers": ["Product Name", "Price", "Key Features", "Rating", "Amazon Search"],
    "rows": [
${amazonProducts.comparisonRows.map(row => `      ${JSON.stringify(row)}`).join(',\n')}
    ]
  }

USE THESE EXACT PRODUCTS - They are REAL Amazon products with verified data.`;
    } else {
      // No Amazon API products - instruct AI to use REAL products from its knowledge
      // Build category-specific product examples based on the keyword/category
      const categoryExamples = getCategoryProductExamples(categorySlug, keyword.keyword);

      categoryComparisonExample = `{
    "headers": ["Product Name", "Price", "Key Features", "Rating", "Amazon Search"],
    "rows": [
      // YOU MUST USE REAL PRODUCTS - see examples below for this category
    ]
  }

**MANDATORY: USE REAL PRODUCTS FROM YOUR KNOWLEDGE**

You are an expert who knows real products sold on Amazon. For "${keyword.keyword}", use ACTUAL products that exist and are sold on Amazon.

${categoryExamples}

STRICT REQUIREMENTS:
1. Use the EXACT brand and product names (e.g., "Sherpa Original Deluxe Carrier" NOT "Top Brand 1")
2. Use realistic prices based on your knowledge (e.g., "$45.99" NOT "$XX.XX")
3. Include real features specific to each product
4. The "Amazon Search" column = product name with + instead of spaces (e.g., "Sherpa+Original+Deluxe+Carrier")
5. Include 4-5 products that are actually available on Amazon

**FAILURE MODE - DO NOT DO THIS:**
- "Top Brand 1", "Top Brand 2" = REJECTED
- "Brand A", "Brand B" = REJECTED
- "Product 1", "Product 2" = REJECTED
- Generic placeholder names = REJECTED

**SUCCESS MODE - DO THIS:**
- "Sherpa Original Deluxe Pet Carrier" = CORRECT
- "Litter-Robot 4" = CORRECT
- "Feliway Classic Diffuser" = CORRECT
- Actual product names you know exist = CORRECT`;
    }

    const categoryFaqExamples = categoryContent.faqTemplates.slice(0, 8).map(faq => 
      `{"question": "${faq.question.replace('{keyword}', keyword.keyword)}", "answer": "${faq.answerHint}, then 150+ word expansion"}`
    ).join(',\n    ');

    const categoryExternalLinkExamples = categoryContent.externalLinks.map(link =>
      `{"url": "${link.url}", "text": "${link.text}", "context": "${link.context}"}`
    ).join(',\n    ');

    // 8. Full SEO-optimized prompt matching V1 quality with DYNAMIC category content
    const prompt = `You are an expert SEO content writer for ${context.categoryName}. Generate an SEO article about "${keyword.keyword}" optimized for Google Featured Snippets.
${serpInsights}
${paaQuestionsText}${amazonProductsPromptText}
TARGET SITE: https://${context.domain}${context.basePath}
EXPERT AUTHOR: ${expertAuthor.name}, ${expertAuthor.title} (${expertAuthor.credentials})

Requirements:
- 3000+ words comprehensive content
- Use "${keyword.keyword}" naturally 8-12 times
- Include comparison table with REAL Amazon products${amazonProducts.products.length > 0 ? ' (USE THE EXACT PRODUCTS PROVIDED ABOVE)' : `: ${comparisonBrands}`}
- Include 8+ detailed FAQs with 150+ word answers
- Include expert quotes and real pricing/data
- Write in authoritative, trustworthy tone
- Include 3-5 external authority links to veterinary sites, manufacturer sites, research journals

INTERNAL LINKING (MANDATORY - REQUIRED FOR SEO SCORE):
**YOU MUST INCLUDE 8-12 INTERNAL LINKS** in the "internalLinks" array. This is NOT optional.
Pick 8-12 URLs from this list and create contextual anchor text for each:
${existingArticlesList || 'No existing articles yet - focus on external authority links'}

INTERNAL LINK RULES (REQUIRED):
- Pick EXACTLY 8-12 URLs from the list above
- Use descriptive anchor text (NOT "click here" or generic text)
- Each link needs: url (copy exactly from list), anchorText, context
- Mix same-category and cross-category links for topical authority
- FAILURE TO INCLUDE internalLinks ARRAY = ARTICLE REJECTED

STRICT SEO REQUIREMENTS FOR 100/100 SCORE (CRITICAL):
**TITLE: NATURALLY CONCISE, MAX 55 CHARACTERS**
- Write a punchy, complete title that naturally fits within 55 characters
- NEVER use "..." or truncated-looking endings
- Use concise phrasing: "Top Picks" not "Complete Comprehensive Guide"
- Pattern: "[Topic]: [Value Prop] [Year]" e.g., "Cat Food Delivery: Best Brands 2026" (36 chars)
- Count characters BEFORE outputting to ensure it fits
- GOOD: "Cat DNA Tests: Top 5 Kits Compared 2026" (40 chars)
- BAD: "The Complete Ultimate Guide to Cat DNA Testing Services & Everything..." (truncated)

**META DESCRIPTION: EXACTLY 145-155 CHARACTERS (not 156+, not 144-)**
- Count EVERY character before outputting
- Include primary keyword naturally once
- Include call-to-action (Discover, Compare, Learn, Find)

**KEYWORD DENSITY: 1.0-1.5%** (For 3000 words = use keyword 30-45 times evenly)

**HEADINGS: 4-8 unique H2s** - No duplicate text, keyword in 2+ H2s

**LINKS: 8-12 internal links (REQUIRED in internalLinks array) + 2-3 external authority links**

AI WRITING DETECTION AVOIDANCE:
- NEVER use em dashes (—). Use commas, colons, or parentheses.
- AVOID: delve, leverage, utilize, foster, bolster, underscore, unveil, navigate, streamline, enhance
- AVOID: robust, comprehensive, pivotal, crucial, vital, transformative, cutting-edge, groundbreaking
- AVOID phrases: "In today's fast-paced world", "It's important to note", "Let's delve into"
- Use varied sentence lengths and natural conversational tone
- Write like a human expert, not an AI

Return ONLY valid JSON:
{
  "title": "[CONCISE, ≤55 chars, no truncation] Punchy title with '${keyword.keyword}'",
  "metaDescription": "[MAX 155 CHARS] Description with '${keyword.keyword}'",
  "quickAnswer": "40-60 word direct answer for Featured Snippet Position 0",
  "keyTakeaways": ["5 key points, 15-25 words each"],
  "images": [
    ${categoryImageExamples}
  ],
  "introduction": "400+ words introducing ${context.categoryName} and this topic",
  "sections": [
    {"heading": "UNIQUE H2 about how ${keyword.keyword} works", "content": "500+ words"},
    {"heading": "DIFFERENT H2 about comparing options", "content": "500+ words"},
    {"heading": "DISTINCT H2 about costs and value", "content": "500+ words"},
    {"heading": "SEPARATE H2 about benefits and features", "content": "500+ words"}
  ],
  "comparisonTable": ${categoryComparisonExample},
  "faqs": [
    ${categoryFaqExamples}
  ],
  "conclusion": "300+ words summarizing key points with call to action",
  "externalLinks": [
    ${categoryExternalLinkExamples}
  ],
  "internalLinks": [
    {"url": "/cat-carriers-travel-products/expandable-cat-carrier", "anchorText": "expandable cat carriers", "context": "For travel, consider expandable cat carriers that provide extra space."},
    {"url": "/cat-dna-testing/best-cat-dna-test", "anchorText": "cat DNA testing", "context": "Understanding your cat's breed through cat DNA testing helps choose the right products."},
    {"url": "/cat-trees-furniture/modern-cat-tree", "anchorText": "modern cat furniture", "context": "Pair your purchase with modern cat furniture for complete home setup."},
    {"url": "/cat-boarding/luxury-cat-boarding", "anchorText": "luxury cat boarding", "context": "When traveling without your cat, luxury cat boarding ensures their comfort."}
  ],
  "wordCount": 3500
}`;

    // 7. Generate with Cloudflare AI (FREE - keeps Copilot for discovery/keywords only)
    console.log(`[SEO-V3] [Step 4/7] Building prompt (${prompt.length} chars)...`);
    console.log(`[SEO-V3] [Step 5/7] Calling Cloudflare AI for "${keyword.keyword}"...`);
    // FIX: Increased timeout from 2min to 5min, fixed response type check
    const aiResult = await generateWithCloudflareAI(prompt, { timeout: 300000 });
    if (!aiResult || !aiResult.content) {
      throw new Error(`Cloudflare AI failed: No content returned`);
    }
    const response = aiResult.content;
    console.log(`[SEO-V3] [Step 5/7] ✓ Cloudflare AI response received (${response.length} chars)`);

    // 8. Parse JSON response
    const jsonMatch = response.match(/\{[\s\S]*"title"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No article JSON in response');
    }
    const sanitizedJson = jsonMatch[0]
      .replace(/[\x00-\x1F\x7F]/g, (char) => {
        if (char === '\t' || char === '\n' || char === '\r') return char;
        return '';
      });
    const article = JSON.parse(sanitizedJson) as ArticleData;

    if (!article.title) {
      throw new Error('Invalid article JSON - missing title');
    }

    // 9. Enforce SEO limits - truncate title and meta description
    const seoLimits = enforceSEOLimits(article);
    article.title = seoLimits.title;
    article.metaDescription = seoLimits.metaDescription;

    // 10. Search for relevant YouTube video using 5-level funnel
    // See .github/skills/video-search-funnel/SKILL.md for specification
    let video: YouTubeVideo | undefined;
    try {
      const categorySlugForVideo = context.categorySlug || context.niche?.replace(/\s+/g, '-').toLowerCase() || 'cat-content';
      console.log(`[SEO-V3] 🎬 Starting video funnel for category: ${categorySlugForVideo}`);
      
      const funnelResult = searchVideoFunnel(keyword.keyword, categorySlugForVideo);
      
      if (funnelResult.video) {
        video = funnelResult.video;
        const levelDesc = funnelResult.fallbackUsed ? 'funny cat fallback' : `level ${funnelResult.level}`;
        console.log(`[SEO-V3] ✅ Video found (${levelDesc}): "${video.title}" by ${video.channel}`);
      } else {
        console.log(`[SEO-V3] ⚠️ No video found after all funnel levels`);
      }
    } catch (err: any) {
      console.log(`[SEO-V3] ⚠️ Video funnel error: ${err.message}`);
    }

    // 10b. Generate AI images for article sections (using FLUX.1 schnell)
    let generatedImages: GeneratedImage[] = [];
    try {
      // Sanitize category slug: remove special chars like & to match URL path format
      const rawCategory = context.categorySlug || context.niche || 'cat-content';
      const categorySlug = rawCategory.toLowerCase()
        .replace(/&amp;/g, '')  // Remove HTML entities
        .replace(/&/g, '')      // Remove raw ampersands
        .replace(/[^a-z0-9]+/g, '-')  // Replace non-alphanumeric with hyphens
        .replace(/(^-|-$)/g, '')  // Trim leading/trailing hyphens
        .replace(/-+/g, '-');     // Collapse multiple hyphens
      const imageResult = await generateArticleImages(
        categorySlug,
        slug,
        keyword.keyword,
        article.title,
        article.sections || [],
        addActivityLog
      );

      if (imageResult.success) {
        generatedImages = imageResult.images;
        console.log(`[SEO-V3] 🖼️ Generated ${generatedImages.length} AI images (${imageResult.neuronsCost} neurons)`);
      } else if (imageResult.errors.length > 0) {
        console.log(`[SEO-V3] ⚠️ Image generation issues: ${imageResult.errors.join(', ')}`);
      }
    } catch (err: any) {
      // Image generation is optional - fallback to Unsplash URLs in article.images
      console.log(`[SEO-V3] ⚠️ AI image generation skipped: ${err.message}`);
    }

    // 11. Build full HTML with schema markup (use V3-specific template)
    const html = buildArticleHtml(article, slug, keyword.keyword, context, video, generatedImages, amazonProducts);

    // 12. Calculate SEO score
    const seoScore = await calculateSEOScore(html, keyword.keyword, article.title, article.metaDescription);
    console.log(`[SEO-V3] 📊 SEO Score: ${seoScore.score}/100`);
    addActivityLog('info', `[V3] SEO Score: ${seoScore.score}/100 for "${keyword.keyword}"`, {
      keyword: keyword.keyword,
      seoScore: seoScore.score
    });

    // 12b. Quality gate - skip deployment for low-quality articles (below 60/100)
    const MIN_SEO_SCORE = 60;
    if (seoScore.score < MIN_SEO_SCORE) {
      console.log(`[SEO-V3] ⚠️ Skipping deployment - SEO score ${seoScore.score} below minimum ${MIN_SEO_SCORE}`);
      addActivityLog('warning', `[V3] Low SEO score: ${article.title}`, {
        keyword: keyword.keyword,
        seoScore: seoScore.score,
        reason: 'Below minimum quality threshold'
      });
      return false;
    }

    // 13. Deploy to KV with V3 prefix (only if SEO score passes threshold)
    console.log(`[SEO-V3] [Step 6/7] Deploying to Cloudflare KV...`);
    const derivedSlugForKv = context?.categorySlug || 'v3-articles';
    const safeKvPrefix = context?.kvPrefix || `${derivedSlugForKv}:`;
    const kvKey = `${safeKvPrefix}${slug}`;
    const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
    if (cfApiToken) {
      const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${encodeURIComponent(kvKey)}`;
      await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'text/html' },
        body: html
      });
      console.log(`[SEO-V3] [Step 6/7] ✓ Deployed: ${kvKey}`);

      const v3Category = safeKvPrefix.replace(':', '').replace(/-/g, '-') || 'cat-trees-condos';
      registerArticleForLinking(slug, v3Category);
      
      // Notify IndexNow for instant indexing
      const articleUrl = `https://${context.domain}${context.basePath}/${slug}`;
      notifyIndexNow(articleUrl);
      
      addActivityLog('deployed', `[V3] Deployed: ${article.title}`, {
        keyword: keyword.keyword,
        slug: slug,
        seoScore: seoScore.score,
        url: articleUrl
      });
      
      // POST-DEPLOY VERIFICATION: Confirm article is accessible (no 404)
      // Use the actual domain from context for verification
      const verifyDomain = context?.domain || 'catsluvus.com';
      const verifyBasePath = context?.basePath || '/cat-dna-testing';
      const verifyUrl = `https://${verifyDomain}${verifyBasePath}/${slug}`;
      let verificationPassed = false;
      let retryCount = 0;
      const maxRetries = 3;
      
      while (!verificationPassed && retryCount < maxRetries) {
        // Wait 2 seconds for KV propagation before checking
        await new Promise(r => setTimeout(r, 2000));
        
        try {
          const verifyResponse = await fetch(verifyUrl, { 
            method: 'HEAD',
            headers: { 'User-Agent': 'SEO-V3-Verification-Bot/1.0' }
          });
          
          if (verifyResponse.status === 200) {
            console.log(`[SEO-V3] ✓ URL Verified: ${verifyUrl} (HTTP ${verifyResponse.status})`);
            verificationPassed = true;
          } else if (verifyResponse.status === 404) {
            retryCount++;
            console.log(`[SEO-V3] ⚠️ 404 detected for ${verifyUrl} - retry ${retryCount}/${maxRetries}`);
            
            if (retryCount < maxRetries) {
              // Re-deploy to KV
              console.log(`[SEO-V3] Re-deploying to KV...`);
              await fetch(url, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${cfApiToken}`, 'Content-Type': 'text/html' },
                body: html
              });
            }
          } else {
            console.log(`[SEO-V3] ⚠️ Unexpected status ${verifyResponse.status} for ${verifyUrl}`);
            verificationPassed = true; // Don't retry on non-404 errors
          }
        } catch (verifyError: any) {
          console.log(`[SEO-V3] ⚠️ Verification fetch failed: ${verifyError.message}`);
          retryCount++;
        }
      }
      
      if (!verificationPassed) {
        console.error(`[SEO-V3] ❌ URL verification FAILED after ${maxRetries} retries: ${verifyUrl}`);
        addActivityLog('error', `[V3] URL still 404 after retries: ${slug}`, {
          url: verifyUrl,
          kvKey: kvKey,
          retries: maxRetries
        });
      }
    } else {
      console.log(`[SEO-V3] [Step 6/7] ⚠️ No Cloudflare API token - skipping deployment`);
    }

    // 14. Update V3 sitemap
    console.log(`[SEO-V3] [Step 7/7] Updating sitemap...`);
    await updateSitemap(slug, context);
    console.log(`[SEO-V3] [Step 7/7] ✓ Sitemap updated`);

    const safeDomain = context?.domain || 'catsluvus.com';
    const derivedSlugForUrl = context?.categorySlug || 'v3-articles';
    const safeBasePath = context?.basePath || `/${derivedSlugForUrl}`;
    const safeKvPrefixForOptimize = context?.kvPrefix || `${derivedSlugForUrl}:`;
    const articleUrl = `https://${safeDomain}${safeBasePath}/${slug}`;

    // 15. Queue PageSpeed analysis with rate limiting (90s min interval, exponential backoff for 429s)
    queuePageSpeedCheck({
      url: articleUrl,
      strategy: 'mobile',
      articleSlug: slug,
      originalHtml: html,
      kvKey: `${safeKvPrefixForOptimize}${slug}`,
      context: context
    });

    console.log(`[SEO-V3] ✅ SUCCESS: "${article.title}" | SEO: ${seoScore.score}/100 | URL: ${articleUrl}`);
    addActivityLog('success', `[V3] Generated: ${article.title}`, {
      keyword: keyword.keyword,
      slug: slug,
      url: articleUrl,
      seoScore: seoScore.score
    });

    return true;
  } catch (error: any) {
    console.error(`[SEO-V3] ❌ FAILED: "${keyword.keyword}" - ${error.message}`);
    console.error(`[SEO-V3] Stack:`, error.stack?.split('\n').slice(0, 5).join('\n'));
    addActivityLog('error', `[V3] Generation failed: ${keyword.keyword}`, { error: error.message });
    return false;
  }
}

async function getAllCategoryStatusKeys(): Promise<string[]> {
  // Dynamic KV query - no hardcoded categories
  // See .github/skills/category-discovery/SKILL.md for discovery standards
  const cfApiToken = secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_API_TOKEN;
  if (!cfApiToken) return [];
  
  const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/keys?prefix=${CATEGORY_STATUS_PREFIX}`;
  try {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${cfApiToken}` } });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return (data.result || []).map((key: any) => key.name.replace(CATEGORY_STATUS_PREFIX, ''));
  } catch (error: any) {
    console.error(`[SEO-V3] ❌ Failed to list category status keys: ${error.message}`);
    return [];
  }
}

async function runV3AutonomousGeneration() {
  if (!v3CategoryContext) {
    console.log('[SEO-V3] 🔍 No active context - checking for in-progress categories...');
    
    // Step 1: Dynamically query KV for all category statuses (no hardcoded list)
    const allCategories = await getAllCategoryStatusKeys();
    
    let foundInProgress: string | null = null;
    console.log(`[SEO-V3] Found ${allCategories.length} categories in KV to check...`);
    
    for (const cat of allCategories) {
      try {
        const status = await getCategoryStatus(cat);
        console.log(`[SEO-V3] Category ${cat}: status=${status?.status || 'not found'}`);
        if (status && status.status === 'in_progress') {
          foundInProgress = cat;
          console.log(`[SEO-V3] ✅ Found in-progress category: ${cat}`);
          break;
        }
      } catch (err: any) {
        console.log(`[SEO-V3] ⚠️ Error checking ${cat}: ${err.message}`);
      }
    }
    
    console.log(`[SEO-V3] Category check complete. Found in-progress: ${foundInProgress || 'none'}`)
    
    if (foundInProgress) {
      // Load context for in-progress category
      console.log(`[SEO-V3] Loading context for: ${foundInProgress}:`);
      const saved = await loadResearchFromKV(`${foundInProgress}:`);
      if (saved.categoryContext && saved.categoryContext.keywords?.length > 0) {
        const pendingCount = saved.categoryContext.keywords.filter(k => k.status === 'pending').length;
        console.log(`[SEO-V3] ✅ Loaded ${saved.categoryContext.niche}: ${pendingCount}/${saved.categoryContext.keywords.length} pending`);
        v3CategoryContext = saved.categoryContext;
        
        // CRITICAL FIX: Sync categoryName with niche to fix breadcrumbs
        if (v3CategoryContext.niche && v3CategoryContext.categoryName !== v3CategoryContext.niche) {
          console.log(`[SEO-V3] 🔧 Syncing categoryName: "${v3CategoryContext.categoryName}" → "${v3CategoryContext.niche}"`);
          v3CategoryContext.categoryName = v3CategoryContext.niche;
        }
        
        // Ensure Worker Route
        await ensureWorkerRouteForCategory(foundInProgress);
      } else {
        console.log(`[SEO-V3] ⚠️ No saved context for ${foundInProgress}, will discover new category`);
        foundInProgress = null;
      }
    }
    
    // Step 2: If no in-progress category, discover next one
    if (!foundInProgress || !v3CategoryContext) {
      console.log('[SEO-V3] 🔄 No in-progress category found - calling discoverNextCategory()...');
      addActivityLog('info', '[V3] Starting category discovery...');
      
      try {
        console.log('[SEO-V3] Calling discoverNextCategory()...');
        const nextCategory = await discoverNextCategory();
        console.log(`[SEO-V3] discoverNextCategory returned: ${JSON.stringify(nextCategory)}`);
        
        if (nextCategory) {
          console.log(`[SEO-V3] ✅ Discovered: ${nextCategory.name} (${nextCategory.slug})`);
          addActivityLog('info', `[V3] Discovered next category: ${nextCategory.name}`);
          
          // Create Worker routes
          await ensureWorkerRouteForCategory(nextCategory.slug);
          
          // Generate keywords
          const keywords = await generateCategoryKeywords(nextCategory);
          console.log(`[SEO-V3] Generated ${keywords.length} keywords for ${nextCategory.name}`);
          
          if (keywords.length >= 5) {
            // Create new v3CategoryContext
            v3CategoryContext = {
              category: nextCategory.slug,
              niche: nextCategory.name,
              domain: 'catsluvus.com',
              basePath: `/${nextCategory.slug}`,
              kvPrefix: `${nextCategory.slug}:`,
              startedAt: new Date().toISOString(),
              keywords: keywords.map((kw: string, idx: number) => ({
                keyword: kw,
                slug: kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
                priority: 'medium',
                score: 50,
                status: 'pending'
              }))
            } as CategoryContext;
            
            // Save in-progress status
            await saveCategoryStatus(nextCategory.slug, {
              category: nextCategory.slug,
              status: 'in_progress',
              articleCount: 0,
              expectedCount: keywords.length,
              avgSeoScore: 0,
              startedAt: new Date().toISOString()
            });
            
            // Save context to KV for persistence
            await saveResearchToKV({ 
              researchPhase: 'generation', 
              selectedNiche: nextCategory.name, 
              keywords: v3CategoryContext.keywords,
              startedAt: v3CategoryContext.startedAt
            } as any, v3CategoryContext);
            
            addActivityLog('success', `[V3] Started category: ${nextCategory.name} (${keywords.length} keywords)`);
            console.log(`[SEO-V3] 🚀 STARTING: ${nextCategory.name} with ${keywords.length} keywords`);
          } else {
            console.log(`[SEO-V3] ⚠️ Only ${keywords.length} keywords for ${nextCategory.name}, need at least 5`);
            addActivityLog('warning', `[V3] Insufficient keywords for ${nextCategory.name}: ${keywords.length}`);
            console.log('[SEO-V3] Will retry in 5 minutes...');
            setTimeout(runV3AutonomousGeneration, 300000);
            return;
          }
        } else {
          console.log('[SEO-V3] ❌ No categories available to discover');
          addActivityLog('info', '[V3] All categories exhausted - V3 autonomous stopped');
          v3AutonomousRunning = false;
          return;
        }
      } catch (error: any) {
        console.error(`[SEO-V3] ❌ Discovery failed: ${error.message}`);
        addActivityLog('error', `[V3] Discovery failed: ${error.message}`);
        console.log('[SEO-V3] Will retry in 5 minutes...');
        setTimeout(runV3AutonomousGeneration, 300000);
        return;
      }
    }
  }

  const pendingKeywords = v3CategoryContext.keywords.filter(k => k.status === 'pending');
  const totalKeywords = v3CategoryContext.keywords.length;
  const completedKeywords = totalKeywords - pendingKeywords.length;
  const completionPct = ((completedKeywords / totalKeywords) * 100).toFixed(1);
  
  if (pendingKeywords.length === 0) {
    const currentNiche = v3CategoryContext.niche || v3CategoryContext.category || 'unknown';
    console.log(`[SEO-V3] ✅ Niche "${currentNiche}" 100% complete! (${totalKeywords} articles)`);
    addActivityLog('success', `[V3] Niche complete: ${currentNiche} (${totalKeywords} articles)`);
    
    // Mark niche as complete in KV to prevent re-discovery on restart
    await saveResearchToKV({ researchPhase: 'niche_complete', selectedNiche: currentNiche, keywords: v3CategoryContext.keywords, completedAt: new Date().toISOString() } as any, v3CategoryContext);
    
    // Also save to category status system
    await saveCategoryStatus(v3CategoryContext.category || keywordToSlug(currentNiche), {
      category: v3CategoryContext.category || keywordToSlug(currentNiche),
      status: 'completed',
      articleCount: totalKeywords,
      expectedCount: totalKeywords,
      avgSeoScore: 85,
      startedAt: v3CategoryContext.startedAt || new Date().toISOString(),
      completedAt: new Date().toISOString()
    });
    
    // V3 AUTONOMOUS: Discover and start next category from exclusive list
    if (v3AutonomousRunning) {
      addActivityLog('info', '[V3] Discovering next high-CPC category...');
      
      try {
        const nextCategory = await discoverNextCategory();
        
        if (nextCategory) {
          addActivityLog('info', `[V3] Found next category: ${nextCategory.name}`);
          
          // Create Worker routes for new category
          await ensureWorkerRouteForCategory(nextCategory.slug);
          
          // Generate keywords for new category
          const keywords = await generateCategoryKeywords(nextCategory);
          
          if (keywords.length >= 5) {
            // Create new v3CategoryContext
            v3CategoryContext = {
              category: nextCategory.slug,
              niche: nextCategory.name,
              domain: 'catsluvus.com',
              basePath: `/${nextCategory.slug}`,
              kvPrefix: `${nextCategory.slug}:`,
              startedAt: new Date().toISOString(),
              keywords: keywords.map((kw: string, idx: number) => ({
                keyword: kw,
                slug: kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
                priority: 'medium',
                score: 50,
                status: 'pending'
              }))
            } as CategoryContext;
            
            // Save in-progress status
            await saveCategoryStatus(nextCategory.slug, {
              category: nextCategory.slug,
              status: 'in_progress',
              articleCount: 0,
              expectedCount: keywords.length,
              avgSeoScore: 0,
              startedAt: new Date().toISOString()
            });
            
            addActivityLog('success', `[V3] Started new category: ${nextCategory.name} (${keywords.length} keywords)`);
            
            // Continue autonomous generation with new category
            setImmediate(runV3AutonomousGeneration);
            return;
          } else {
            addActivityLog('warning', `[V3] Only ${keywords.length} keywords for ${nextCategory.name}, skipping`);
          }
        } else {
          addActivityLog('info', '[V3] No more categories available');
        }
      } catch (error: any) {
        addActivityLog('error', `[V3] Category discovery failed: ${error.message}`);
      }
    }
    
    // Clear context - no more work
    v3CategoryContext = null;
    return;
  }

  // Sort by priority: HIGH > MEDIUM > LOW, then by score (highest first)
  // Normalize priority to lowercase for consistent sorting
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sortedPending = [...pendingKeywords].sort((a, b) => {
    const aPriority = (a.priority || 'low').toLowerCase();
    const bPriority = (b.priority || 'low').toLowerCase();
    const priorityDiff = (priorityOrder[aPriority] ?? 2) - (priorityOrder[bPriority] ?? 2);
    if (priorityDiff !== 0) return priorityDiff;
    return (b.score || 0) - (a.score || 0);
  });

  const nextKeyword = sortedPending[0];
  console.log(`[SEO-V3] 📊 Niche Progress: ${completedKeywords}/${totalKeywords} (${completionPct}%) | Next: [${nextKeyword.priority?.toUpperCase()}] "${nextKeyword.keyword}"`);
  
  await generateV3Article(nextKeyword, v3CategoryContext);
  nextKeyword.status = 'published';
  
  // Save progress to KV after each article (using 'in_progress' status to distinguish from complete)
  await saveResearchToKV({ researchPhase: 'generation_in_progress', selectedNiche: v3CategoryContext.niche, keywords: v3CategoryContext.keywords } as any, v3CategoryContext);

  // Continue with next article
  if (v3AutonomousRunning) {
    setImmediate(runV3AutonomousGeneration);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NOTE: V1 Pet Insurance generation runs independently in seo-generator.ts
// V3 handles dynamic category discovery with Cloudflare AI generation
// V3's own auto-start is below (v3AutonomousRunning with 15s delay)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// FREE PAGESPEED INSIGHTS API (No API key required for basic usage)
// ═══════════════════════════════════════════════════════════════════════════

// PageSpeedResult interface is defined at the top of the file

async function analyzePageSpeed(url: string, strategy: 'mobile' | 'desktop' = 'mobile'): Promise<PageSpeedResult> {
  const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&category=seo&category=accessibility&category=best-practices`;
  
  console.log(`[PageSpeed] Analyzing ${url} (${strategy})...`);
  
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`PageSpeed API error: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  const lighthouse = data.lighthouseResult;
  
  if (!lighthouse) {
    throw new Error('No Lighthouse results in response');
  }
  
  const opportunities: PageSpeedResult['opportunities'] = [];
  const opportunityAudits = [
    'render-blocking-resources',
    'unused-css-rules',
    'unused-javascript',
    'modern-image-formats',
    'offscreen-images',
    'efficient-animated-content',
    'duplicated-javascript',
    'legacy-javascript',
    'unminified-css',
    'unminified-javascript'
  ];
  
  for (const auditId of opportunityAudits) {
    const audit = lighthouse.audits?.[auditId];
    if (audit && audit.score !== null && audit.score < 1) {
      opportunities.push({
        title: audit.title || auditId,
        description: audit.description || '',
        savings: audit.displayValue || 'Potential savings'
      });
    }
  }
  
  const result: PageSpeedResult = {
    url,
    strategy,
    scores: {
      performance: Math.round((lighthouse.categories?.performance?.score || 0) * 100),
      accessibility: Math.round((lighthouse.categories?.accessibility?.score || 0) * 100),
      bestPractices: Math.round((lighthouse.categories?.['best-practices']?.score || 0) * 100),
      seo: Math.round((lighthouse.categories?.seo?.score || 0) * 100)
    },
    coreWebVitals: {
      lcp: Math.round(lighthouse.audits?.['largest-contentful-paint']?.numericValue || 0),
      cls: parseFloat((lighthouse.audits?.['cumulative-layout-shift']?.numericValue || 0).toFixed(3)),
      tbt: Math.round(lighthouse.audits?.['total-blocking-time']?.numericValue || 0),
      fcp: Math.round(lighthouse.audits?.['first-contentful-paint']?.numericValue || 0),
      si: Math.round(lighthouse.audits?.['speed-index']?.numericValue || 0),
      ttfb: Math.round(lighthouse.audits?.['server-response-time']?.numericValue || 0)
    },
    opportunities,
    fetchedAt: new Date().toISOString()
  };
  
  console.log(`[PageSpeed] ${url}: Performance ${result.scores.performance}/100, SEO ${result.scores.seo}/100, LCP ${result.coreWebVitals.lcp}ms`);
  
  return result;
}

function getPageSpeedGrade(score: number): { grade: string; color: string; status: string } {
  if (score >= 90) return { grade: 'A', color: 'green', status: 'Good' };
  if (score >= 50) return { grade: 'B', color: 'orange', status: 'Needs Improvement' };
  return { grade: 'C', color: 'red', status: 'Poor' };
}

function getCoreWebVitalStatus(metric: string, value: number): { status: string; color: string } {
  switch (metric) {
    case 'lcp':
      if (value <= 2500) return { status: 'Good', color: 'green' };
      if (value <= 4000) return { status: 'Needs Improvement', color: 'orange' };
      return { status: 'Poor', color: 'red' };
    case 'cls':
      if (value <= 0.1) return { status: 'Good', color: 'green' };
      if (value <= 0.25) return { status: 'Needs Improvement', color: 'orange' };
      return { status: 'Poor', color: 'red' };
    case 'tbt':
      if (value <= 200) return { status: 'Good', color: 'green' };
      if (value <= 600) return { status: 'Needs Improvement', color: 'orange' };
      return { status: 'Poor', color: 'red' };
    case 'ttfb':
      if (value <= 800) return { status: 'Good', color: 'green' };
      if (value <= 1800) return { status: 'Needs Improvement', color: 'orange' };
      return { status: 'Poor', color: 'red' };
    default:
      return { status: 'Unknown', color: 'gray' };
  }
}

/**
 * Auto-optimize article HTML for better performance scores
 * Applies lazy loading, image optimization, and other fixes
 */
function optimizeArticleHtml(html: string): string {
  let optimized = html;
  
  // 0. Add preconnect hints for external resources (reduces DNS/TCP latency by 100-300ms each)
  const preconnectTags = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preconnect" href="https://images.unsplash.com">
<link rel="preconnect" href="https://i.ytimg.com">`;
  
  if (!optimized.includes('rel="preconnect"')) {
    optimized = optimized.replace(/<head([^>]*)>/i, `<head$1>${preconnectTags}`);
  }
  
  // 1. Add lazy loading to all images except first (hero image)
  let imageCount = 0;
  optimized = optimized.replace(/<img([^>]*)>/gi, (match, attrs) => {
    imageCount++;
    if (attrs.includes('loading=')) return match; // Already has loading attr
    
    if (imageCount === 1) {
      return `<img${attrs} loading="eager" decoding="async">`;
    } else {
      return `<img${attrs} loading="lazy" decoding="async">`;
    }
  });
  
  // 2. Add dimensions to images without them (prevents CLS)
  optimized = optimized.replace(/<img([^>]*)>/gi, (match, attrs) => {
    if (!attrs.includes('width=') && !attrs.includes('style=')) {
      return match.replace('>', ' width="800" height="600" style="aspect-ratio: 4/3;">');
    }
    return match;
  });
  
  // 3. Optimize Unsplash URLs for WebP format
  optimized = optimized.replace(
    /https:\/\/images\.unsplash\.com\/([^"'\s\?]+)(?:\?[^"'\s]*)?/g,
    'https://images.unsplash.com/$1?w=800&q=80&fm=webp&auto=format'
  );
  
  // 4. Replace YouTube iframes with lightweight facades (biggest performance win)
  optimized = optimized.replace(
    /<iframe[^>]*src=["'](?:https?:)?\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\/([a-zA-Z0-9_-]+)[^"']*["'][^>]*><\/iframe>/gi,
    (match, videoId) => {
      return `<div class="yt-facade" style="position:relative;padding-bottom:56.25%;background:#000;cursor:pointer;" onclick="this.innerHTML='<iframe src=\\'https://www.youtube.com/embed/${videoId}?autoplay=1\\' style=\\'position:absolute;top:0;left:0;width:100%;height:100%;border:0\\' allow=\\'autoplay;encrypted-media\\' allowfullscreen></iframe>'">
  <img src="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg" alt="Video" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;" loading="lazy">
  <svg style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:68px;height:48px;" viewBox="0 0 68 48"><path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55c-2.93.78-4.63 3.26-5.42 6.19C.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="red"/><path d="M45 24L27 14v20" fill="white"/></svg>
</div>`;
    }
  );
  
  // 5. Add loading="lazy" to remaining iframes
  optimized = optimized.replace(/<iframe([^>]*)>/gi, (match, attrs) => {
    if (!attrs.includes('loading=')) {
      return `<iframe${attrs} loading="lazy">`;
    }
    return match;
  });
  
  // 5. Defer non-critical scripts
  optimized = optimized.replace(/<script([^>]*?)src=["']([^"']+)["']([^>]*)>/gi, (match, before, src, after) => {
    if (!before.includes('defer') && !before.includes('async')) {
      return `<script${before}src="${src}" defer${after}>`;
    }
    return match;
  });
  
  // 6. Add font-display: swap to any @font-face rules
  optimized = optimized.replace(/@font-face\s*\{([^}]+)\}/gi, (match, content) => {
    if (!content.includes('font-display')) {
      return `@font-face {${content}font-display: swap;}`;
    }
    return match;
  });
  
  return optimized;
}

// PageSpeed Queue Status Endpoint
router.get('/pagespeed/queue', (req: Request, res: Response) => {
  const now = Date.now();
  const timeSinceLastCall = now - pageSpeedLastCall;
  const nextCheckIn = Math.max(0, PAGESPEED_MIN_INTERVAL - timeSinceLastCall);
  
  res.json({
    success: true,
    queue: {
      size: pageSpeedQueue.length,
      processing: pageSpeedProcessing,
      lastCallAgo: Math.round(timeSinceLastCall / 1000),
      nextCheckIn: Math.round(nextCheckIn / 1000),
      minInterval: PAGESPEED_MIN_INTERVAL / 1000,
      items: pageSpeedQueue.map(item => ({
        slug: item.articleSlug,
        retryCount: item.retryCount,
        waitingFor: Math.round((now - item.addedAt) / 1000)
      }))
    },
    settings: {
      minIntervalSeconds: PAGESPEED_MIN_INTERVAL / 1000,
      maxRetries: PAGESPEED_MAX_RETRIES,
      backoffBaseSeconds: PAGESPEED_BACKOFF_BASE / 1000
    }
  });
});

// PageSpeed Analysis Endpoint (FREE - no API key required)
router.get('/pagespeed', async (req: Request, res: Response) => {
  try {
    const url = req.query.url as string;
    const strategy = (req.query.strategy as 'mobile' | 'desktop') || 'mobile';
    
    if (!url) {
      return res.status(400).json({ error: 'URL parameter required' });
    }
    
    const result = await analyzePageSpeed(url, strategy);
    
    const performanceGrade = getPageSpeedGrade(result.scores.performance);
    const seoGrade = getPageSpeedGrade(result.scores.seo);
    
    res.json({
      success: true,
      data: {
        ...result,
        grades: {
          performance: performanceGrade,
          accessibility: getPageSpeedGrade(result.scores.accessibility),
          bestPractices: getPageSpeedGrade(result.scores.bestPractices),
          seo: seoGrade
        },
        coreWebVitalStatus: {
          lcp: getCoreWebVitalStatus('lcp', result.coreWebVitals.lcp),
          cls: getCoreWebVitalStatus('cls', result.coreWebVitals.cls),
          tbt: getCoreWebVitalStatus('tbt', result.coreWebVitals.tbt),
          ttfb: getCoreWebVitalStatus('ttfb', result.coreWebVitals.ttfb)
        },
        passesThresholds: {
          performance: result.scores.performance >= 90,
          seo: result.scores.seo >= 90,
          lcp: result.coreWebVitals.lcp <= 2500,
          cls: result.coreWebVitals.cls <= 0.1
        }
      }
    });
  } catch (error: any) {
    console.error('[PageSpeed] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Batch PageSpeed Analysis (analyze multiple URLs)
router.post('/pagespeed/batch', async (req: Request, res: Response) => {
  try {
    const { urls, strategy = 'mobile' } = req.body;
    
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'URLs array required' });
    }
    
    if (urls.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 URLs per batch' });
    }
    
    const results: PageSpeedResult[] = [];
    const errors: { url: string; error: string }[] = [];
    
    for (const url of urls) {
      try {
        const result = await analyzePageSpeed(url, strategy);
        results.push(result);
      } catch (error: any) {
        errors.push({ url, error: error.message });
      }
    }
    
    const avgPerformance = results.length > 0 
      ? Math.round(results.reduce((sum, r) => sum + r.scores.performance, 0) / results.length)
      : 0;
    
    res.json({
      success: true,
      data: {
        results,
        errors,
        summary: {
          totalAnalyzed: results.length,
          totalErrors: errors.length,
          averagePerformance: avgPerformance,
          averageSeo: results.length > 0 
            ? Math.round(results.reduce((sum, r) => sum + r.scores.seo, 0) / results.length)
            : 0
        }
      }
    });
  } catch (error: any) {
    console.error('[PageSpeed] Batch error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// V3 AUTO-START (New Category Discovery - autonomous research + generation)
// ═══════════════════════════════════════════════════════════════════════════
// NOTE: V3 auto-starts the research pipeline that discovers NEW categories
// Uses Cloudflare AI for content generation (independent from V2's Copilot CLI)
// The petinsurance queue is handled by V1 (seo-generator.ts).
// ═══════════════════════════════════════════════════════════════════════════

console.log('[SEO-V3] Module loaded - scheduling V3 research pipeline auto-start in 15 seconds...');

// Auto-start V3 research pipeline (discovers new categories, NOT petinsurance)
setTimeout(() => {
  console.log('[SEO-V3] setTimeout triggered for V3 research pipeline...');
  if (!v3AutonomousRunning) {
    console.log('[SEO-V3] 🔬 Auto-starting V3 autonomous research pipeline...');
    v3AutonomousRunning = true;
    addActivityLog('info', '[V3] Auto-starting autonomous research & generation pipeline (new category discovery)');
    runV3AutonomousGeneration();
  } else {
    console.log('[SEO-V3] V3 research pipeline already running, skipping auto-start');
  }
}, 15000); // Wait 15 seconds to let V1 start first

export default router;
