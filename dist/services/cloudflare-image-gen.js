"use strict";
/**
 * Cloudflare Workers AI Image Generation Service
 * Uses FLUX.1 [schnell] for cost-effective image generation (~173 images/day free)
 * Stores images in R2 bucket: seo-images
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.testImageGeneration = exports.generateArticleImages = exports.getImageQuotaStatus = void 0;
const doppler_secrets_1 = require("./doppler-secrets");
// Cloudflare account config
const CLOUDFLARE_ACCOUNT_ID = 'bc8e15f958dc350e00c0e39d80ca6941';
const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
// R2 bucket name
const R2_BUCKET_NAME = 'seo-images';
// Rate limiting (173 images/day on free tier)
const DAILY_IMAGE_LIMIT = 170; // Leave buffer
let dailyImageCount = 0;
let dailyResetDate = new Date().toDateString();
// =============================================================================
// KEYWORD-FOCUSED IMAGE GENERATION
// Images that visually communicate the article topic at a glance
// Topic detection → Literal scene description → Photorealistic output
// =============================================================================
// Vision verification - max retries before accepting any image
const MAX_IMAGE_RETRIES = 3;
/**
 * Verify image relevance using OpenAI Vision API
 * STRICT verification: Image must clearly relate to the keyword topic
 */
async function verifyImageRelevance(imageBase64, keyword, log) {
    // Check multiple possible env var names for OpenAI key
    const openaiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
    if (!openaiKey) {
        log('warning', '[Vision] No OpenAI key - skipping verification', {});
        return { relevant: true, reason: 'No API key for verification' };
    }
    // Extract core topic from keyword for verification
    const coreTopic = keyword.toLowerCase()
        .replace(/\b(best|top|review|guide|how to|what is|2024|2025|2026)\b/gi, '')
        .trim();
    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openaiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: `You are a strict image validator for a cat care website. Check if this image is appropriate for an article about: "${keyword}"

REJECT the image if ANY of these are true:
- Cat is wearing clothes, costumes, hats, glasses, or accessories
- Cat is in a silly/absurd scenario (driving, cooking, at desk, etc.)
- Image contains ANY text, words, letters, or watermarks
- Image is a cartoon, illustration, or AI art that looks fake
- Image has NOTHING to do with "${coreTopic}"

ACCEPT only if:
- Shows a real, natural-looking cat
- Visually relates to the topic "${coreTopic}"
- No text anywhere in the image
- Would look professional on a pet care website

Respond JSON only:
{"pass": true/false, "reason": "10 words max why"}

Be VERY strict. When in doubt, reject.`
                            },
                            {
                                type: 'image_url',
                                image_url: {
                                    url: `data:image/png;base64,${imageBase64}`,
                                    detail: 'low'
                                }
                            }
                        ]
                    }
                ],
                max_tokens: 100
            })
        });
        if (!response.ok) {
            log('warning', `[Vision] API error: ${response.status}`, {});
            return { relevant: true, reason: 'API error, accepting image' };
        }
        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || '';
        // Parse JSON response
        const jsonMatch = content.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            const passed = result.pass === true;
            log('info', `[Vision] ${passed ? '✅ PASS' : '❌ FAIL'}: ${result.reason}`, { keyword });
            return { relevant: passed, reason: result.reason };
        }
        return { relevant: true, reason: 'Could not parse response' };
    }
    catch (error) {
        log('warning', `[Vision] Error: ${error.message}`, {});
        return { relevant: true, reason: 'Error during verification' };
    }
}
/**
 * Check if we can generate more images today
 */
function canGenerateImage() {
    const today = new Date().toDateString();
    if (dailyResetDate !== today) {
        dailyImageCount = 0;
        dailyResetDate = today;
    }
    return dailyImageCount < DAILY_IMAGE_LIMIT;
}
/**
 * Record image generation for rate limiting
 */
function recordImageGeneration(count = 1) {
    dailyImageCount += count;
}
/**
 * Get current image quota status
 */
function getImageQuotaStatus() {
    const today = new Date().toDateString();
    if (dailyResetDate !== today) {
        dailyImageCount = 0;
        dailyResetDate = today;
    }
    return {
        used: dailyImageCount,
        limit: DAILY_IMAGE_LIMIT,
        remaining: DAILY_IMAGE_LIMIT - dailyImageCount,
        resetDate: dailyResetDate
    };
}
exports.getImageQuotaStatus = getImageQuotaStatus;
/**
 * Extract image contexts for article (hero + 1 optional mid-article image)
 * SEO Best Practice: Only 1-2 images per article that add real value
 * More images ≠ better SEO. Only add images that help explain the content.
 */
function extractImageContexts(articleTitle, sections) {
    const contexts = [];
    // Extract first 3 H2 headings for topic context
    const topH2s = (sections && Array.isArray(sections))
        ? sections.slice(0, 3).map(s => s.heading.replace(/\d+/g, '').replace(/[^\w\s]/g, '').trim())
        : [];
    // Hero image based on article title (always include)
    contexts.push({
        index: 0,
        heading: articleTitle,
        headingClean: articleTitle.replace(/\d+/g, '').replace(/[^\w\s]/g, '').trim(),
        imageType: 'hero',
        articleTitle: articleTitle,
        topH2s: topH2s
    });
    // Add 1 mid-article section image only for longer articles (3+ sections)
    if (sections && Array.isArray(sections) && sections.length >= 3) {
        // Pick the middle section for the image
        const midIndex = Math.floor(sections.length / 2);
        const midSection = sections[midIndex];
        contexts.push({
            index: midIndex + 1,
            heading: midSection.heading,
            headingClean: midSection.heading.replace(/\d+/g, '').replace(/[^\w\s]/g, '').trim(),
            imageType: 'section',
            articleTitle: articleTitle,
            topH2s: topH2s
        });
    }
    // No closing image - it adds no value, just decoration
    return contexts;
}
/**
 * Generate KEYWORD-FOCUSED image prompt
 *
 * DIRECT APPROACH: Extract the core subject and create a literal visual.
 * The image should instantly communicate what the article is about.
 *
 * Examples:
 * - "cat flea treatment" → cat being treated for fleas, close-up
 * - "best cat food for sensitive stomach" → cat eating from premium bowl
 * - "how to trim cat nails" → hands trimming cat's nails
 * - "cat dental care tips" → cat with healthy teeth, vet examining
 */
function generateImagePrompt(category, sectionContext, keyword) {
    // Extract the CORE SUBJECT from the keyword
    const lowerKeyword = keyword.toLowerCase();
    // Remove filler words to get the real topic
    const coreSubject = lowerKeyword
        .replace(/\b(best|top|review|reviews|guide|how to|what is|why|when|where|can|should|do|does|the|a|an|for|with|and|or|your|my|our|their|2024|2025|2026|near me|online|cheap|affordable|premium|luxury)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    // Detect the PRIMARY ACTION or TOPIC (ordered by specificity - most specific first)
    // Using word boundaries \b to avoid false matches (e.g., "treatment" matching "eat")
    const topics = {
        medical: /\b(flea|tick|worm|parasite|treatment|medicine|vet|health|sick|disease|symptom|vaccine|shot)\b/i,
        dental: /\b(dental|teeth|tooth|mouth|breath|gum)\b/i,
        grooming: /\b(groom|brush|comb|fur|hair|bath|wash|nail|trim|shed|mat)\b/i,
        behavior: /\b(behavior|train|scratch|bite|meow|sleep|play|stress|anxiety|aggress)\b/i,
        supplies: /\b(litter|carrier|toy|tree|post|fountain)\b/i,
        insurance: /\b(insurance|coverage|policy|claim|vet bill)\b/i,
        breed: /\b(breed|kitten|persian|siamese|maine coon|bengal|ragdoll|british)\b/i,
        feeding: /\b(food|feed|diet|nutrition|meal|hungry|appetite|eat)\b/i
    };
    // Find matching topic
    let detectedTopic = 'general';
    for (const [topic, pattern] of Object.entries(topics)) {
        if (pattern.test(lowerKeyword)) {
            detectedTopic = topic;
            break;
        }
    }
    // Build a SPECIFIC, LITERAL scene based on topic
    let scene;
    switch (detectedTopic) {
        case 'feeding':
            scene = `close-up photograph of a healthy cat eating from a food bowl, ${coreSubject}, kitchen or home setting, natural daylight, cat looks content and healthy`;
            break;
        case 'medical':
            scene = `veterinarian gently examining a calm cat on examination table, ${coreSubject}, professional veterinary clinic, caring hands, cat looks relaxed`;
            break;
        case 'grooming':
            scene = `person gently grooming a relaxed cat, ${coreSubject}, showing the grooming action clearly, cat enjoying the attention, soft natural lighting`;
            break;
        case 'dental':
            scene = `close-up of a cat with mouth slightly open showing healthy teeth, ${coreSubject}, veterinary dental check, clean professional setting`;
            break;
        case 'behavior':
            scene = `expressive cat demonstrating natural behavior, ${coreSubject}, home environment, cat's body language clearly visible, candid moment`;
            break;
        case 'supplies':
            scene = `cat interacting with pet supplies, ${coreSubject}, the product clearly visible in use, modern home setting, cat engaged and happy`;
            break;
        case 'insurance':
            scene = `happy healthy cat being held by caring owner, ${coreSubject}, suggesting pet healthcare and protection, warm family moment`;
            break;
        case 'breed':
            scene = `beautiful purebred cat portrait, ${coreSubject}, showing distinctive breed features, professional pet photography, stunning coat and eyes`;
            break;
        default:
            scene = `adorable cat in a cozy home setting, ${coreSubject}, warm natural lighting, cat looking directly at camera, engaging expression`;
    }
    // Build final prompt - SHORT and SPECIFIC
    const prompt = [
        'Generate image with NO TEXT NO WORDS NO LETTERS anywhere',
        scene,
        'real photograph, not illustration, photorealistic, high quality, sharp focus',
        'natural cat, no costumes, no clothes, no accessories on cat'
    ].join('. ');
    return prompt;
}
/**
 * Generate a single image using Cloudflare Workers AI FLUX.1 schnell
 */
async function generateSingleImage(prompt, width = 1024, height = 768) {
    // Use Workers AI specific token, fall back to general token
    const apiToken = doppler_secrets_1.secrets.get('CLOUDFLARE_WORKERS_AI_TOKEN') || doppler_secrets_1.secrets.get('CLOUDFLARE_API_TOKEN') || process.env.CLOUDFLARE_WORKERS_AI_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
    if (!apiToken) {
        console.error('[Image Gen] No Cloudflare Workers AI token configured. Add CLOUDFLARE_WORKERS_AI_TOKEN to Doppler.');
        return null;
    }
    const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${IMAGE_MODEL}`;
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prompt,
                width,
                height
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Image Gen] FLUX API error: ${response.status} - ${errorText}`);
            return null;
        }
        // FLUX returns JSON with base64-encoded image
        const data = await response.json();
        if (!data.result?.image) {
            console.error('[Image Gen] FLUX API returned no image data');
            return null;
        }
        // Decode base64 to binary
        const base64Image = data.result.image;
        const binaryString = atob(base64Image);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }
    catch (error) {
        console.error(`[Image Gen] Request failed: ${error.message}`);
        return null;
    }
}
/**
 * Store image in R2 bucket via Cloudflare API
 */
async function storeImageInR2(imageBuffer, r2Key) {
    // Upload via Worker endpoint (has R2 binding)
    const workerUrl = 'https://petinsurance.webmaster-bc8.workers.dev/img/upload';
    try {
        // Convert ArrayBuffer to base64
        const bytes = new Uint8Array(imageBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64Image = Buffer.from(binary, 'binary').toString('base64');
        const response = await fetch(workerUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                key: r2Key,
                image: base64Image,
                contentType: 'image/png'
            })
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Image Gen] R2 upload error: ${response.status} - ${errorText}`);
            return false;
        }
        const result = await response.json();
        if (result.success) {
            console.log(`[Image Gen] ✅ Uploaded to R2: ${r2Key} (${result.size} bytes)`);
            return true;
        }
        console.error(`[Image Gen] R2 upload failed: ${result.error}`);
        return false;
    }
    catch (error) {
        console.error(`[Image Gen] R2 upload failed: ${error.message}`);
        return false;
    }
}
/**
 * Generate image caption based on context
 */
function generateCaption(category, sectionContext, keyword) {
    const categoryName = category.replace(/-/g, ' ');
    switch (sectionContext.imageType) {
        case 'hero':
            return `Complete guide to ${keyword} - expert recommendations and comparisons`;
        case 'closing':
            return `Summary: Everything you need to know about ${keyword}`;
        default:
            return `${sectionContext.heading} - ${categoryName} expert guide`;
    }
}
/**
 * Generate alt text for SEO
 */
function generateAltText(category, sectionContext, keyword) {
    const categoryName = category.replace(/-/g, ' ');
    switch (sectionContext.imageType) {
        case 'hero':
            return `${keyword} - ${categoryName} guide hero image`;
        case 'closing':
            return `${keyword} summary infographic`;
        default:
            return `${sectionContext.headingClean} - ${categoryName}`;
    }
}
/**
 * Main function: Generate all images for an article
 */
async function generateArticleImages(category, slug, keyword, articleTitle, sections, addActivityLog) {
    const startTime = Date.now();
    // Sanitize category and slug for R2 storage paths (remove special chars like &)
    const safeCategory = category.toLowerCase()
        .replace(/&amp;/g, '')
        .replace(/&/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .replace(/-+/g, '-');
    const safeSlug = slug.toLowerCase()
        .replace(/&amp;/g, '')
        .replace(/&/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .replace(/-+/g, '-');
    const result = {
        success: false,
        images: [],
        errors: [],
        neuronsCost: 0,
        timing: { totalMs: 0, perImageMs: [] }
    };
    const log = addActivityLog || ((level, msg) => console.log(`[Image Gen] ${msg}`));
    // Check rate limit
    if (!canGenerateImage()) {
        log('warning', `[V3] Image generation quota exceeded (${dailyImageCount}/${DAILY_IMAGE_LIMIT})`, {});
        result.errors.push('Daily image quota exceeded');
        return result;
    }
    // Extract image contexts (hero + optional 1 mid-article image)
    // SEO Best Practice: 1-2 purposeful images, not decorative filler
    const imageContexts = extractImageContexts(articleTitle, sections);
    // Max 2 images per article (hero + 1 section for longer articles)
    const maxImages = 2;
    const imagesToGenerate = imageContexts.slice(0, maxImages);
    log('info', `[V3] Generating ${imagesToGenerate.length} AI images for "${keyword}"...`, {
        category,
        slug,
        imageCount: imagesToGenerate.length
    });
    // Generate images sequentially with rate limiting and verification
    for (const context of imagesToGenerate) {
        // Check quota before each image
        if (!canGenerateImage()) {
            log('warning', '[V3] Image quota reached mid-generation', {});
            break;
        }
        const imageStart = Date.now();
        let imageBuffer = null;
        let prompt = '';
        let attempt = 0;
        let verificationPassed = false;
        let lastBase64 = '';
        // Retry loop with verification
        while (attempt < MAX_IMAGE_RETRIES && !verificationPassed) {
            attempt++;
            // Check quota before each attempt
            if (!canGenerateImage()) {
                log('warning', '[V3] Image quota reached during retry', {});
                break;
            }
            // Generate prompt (same for all attempts - it's keyword-literal now)
            prompt = generateImagePrompt(category, context, keyword);
            if (attempt === 1) {
                log('info', `[V3] Generating ${context.imageType} image for "${keyword}"...`, {
                    prompt: prompt.substring(0, 120) + '...'
                });
            }
            else {
                log('info', `[V3] Retry ${attempt}/${MAX_IMAGE_RETRIES} for "${keyword}"...`, {});
            }
            // Generate image
            imageBuffer = await generateSingleImage(prompt, 1024, 768);
            if (!imageBuffer) {
                log('warning', `[V3] Generation failed on attempt ${attempt}`, {});
                continue;
            }
            // Convert to base64 for verification
            const bytes = new Uint8Array(imageBuffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            lastBase64 = Buffer.from(binary, 'binary').toString('base64');
            // Verify with vision API
            const verification = await verifyImageRelevance(lastBase64, keyword, log);
            if (verification.relevant) {
                verificationPassed = true;
                log('success', `[V3] Image verified for "${keyword}": ${verification.reason}`, {});
            }
            else {
                log('warning', `[V3] Image rejected: ${verification.reason}`, { attempt });
                imageBuffer = null; // Clear so we retry
            }
        }
        // If all retries failed, accept the last image anyway
        if (!verificationPassed && lastBase64) {
            log('warning', `[V3] Max retries reached, using last generated image`, {});
            // Reconstruct buffer from base64
            const binaryString = atob(lastBase64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            imageBuffer = bytes.buffer;
        }
        if (!imageBuffer) {
            result.errors.push(`Failed to generate ${context.imageType} image after ${attempt} attempts`);
            result.timing.perImageMs.push(Date.now() - imageStart);
            continue;
        }
        // Determine R2 key (use sanitized category/slug for URL-safe paths)
        let r2Key;
        switch (context.imageType) {
            case 'hero':
                r2Key = `${safeCategory}/${safeSlug}/hero.png`;
                break;
            case 'closing':
                r2Key = `${safeCategory}/${safeSlug}/closing.png`;
                break;
            default:
                r2Key = `${safeCategory}/${safeSlug}/section-${context.index}.png`;
        }
        // Store in R2
        const stored = await storeImageInR2(imageBuffer, r2Key);
        if (stored) {
            const generatedImage = {
                url: `/img/${r2Key}`,
                alt: generateAltText(safeCategory, context, keyword),
                caption: generateCaption(safeCategory, context, keyword),
                width: 1024,
                height: 768,
                imageType: context.imageType,
                sectionIndex: context.index,
                prompt: prompt,
                r2Key: r2Key
            };
            result.images.push(generatedImage);
            recordImageGeneration(attempt); // Count all attempts
            // FLUX.1 schnell: ~57.6 neurons per 1024x768 image × attempts
            result.neuronsCost += 58 * attempt;
            log('success', `[V3] ${context.imageType} image stored: ${r2Key} (${attempt} attempt${attempt > 1 ? 's' : ''})`, {
                r2Key,
                neuronsCost: 58 * attempt,
                attempts: attempt
            });
        }
        else {
            result.errors.push(`Failed to store ${context.imageType} image to R2`);
        }
        result.timing.perImageMs.push(Date.now() - imageStart);
        // Rate limiting delay between images (2 seconds)
        if (imagesToGenerate.indexOf(context) < imagesToGenerate.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    result.timing.totalMs = Date.now() - startTime;
    result.success = result.images.length > 0;
    log(result.success ? 'success' : 'warning', `[V3] Image generation complete: ${result.images.length}/${imagesToGenerate.length} images`, {
        totalMs: result.timing.totalMs,
        neuronsCost: result.neuronsCost,
        errors: result.errors.length > 0 ? result.errors : undefined
    });
    return result;
}
exports.generateArticleImages = generateArticleImages;
/**
 * Test image generation with a simple prompt
 */
async function testImageGeneration() {
    const testPrompt = 'A cute cat sitting on a modern cat tree, professional photography, warm lighting';
    console.log('[Image Gen] Testing FLUX.1 schnell with prompt:', testPrompt);
    const imageBuffer = await generateSingleImage(testPrompt, 512, 512);
    if (!imageBuffer) {
        return { success: false, message: 'Failed to generate test image' };
    }
    // Store test image
    const testKey = `test/test-${Date.now()}.png`;
    const stored = await storeImageInR2(imageBuffer, testKey);
    if (!stored) {
        return { success: false, message: 'Image generated but failed to store in R2' };
    }
    return {
        success: true,
        message: 'Test image generated and stored successfully',
        imageUrl: `/img/${testKey}`
    };
}
exports.testImageGeneration = testImageGeneration;
//# sourceMappingURL=cloudflare-image-gen.js.map