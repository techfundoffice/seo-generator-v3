/**
 * Cloudflare Workers AI Image Generation Service
 * Uses FLUX.1 [schnell] for cost-effective image generation (~173 images/day free)
 * Stores images in R2 bucket: seo-images
 */
export interface ArticleSection {
    heading: string;
    content: string;
}
export interface GeneratedImage {
    url: string;
    alt: string;
    caption: string;
    width: number;
    height: number;
    imageType: 'hero' | 'section' | 'closing';
    sectionIndex: number;
    prompt: string;
    r2Key: string;
}
export interface ImageGenerationResult {
    success: boolean;
    images: GeneratedImage[];
    errors: string[];
    neuronsCost: number;
    timing: {
        totalMs: number;
        perImageMs: number[];
    };
}
/**
 * Get current image quota status
 */
export declare function getImageQuotaStatus(): {
    used: number;
    limit: number;
    remaining: number;
    resetDate: string;
};
/**
 * Main function: Generate all images for an article
 */
export declare function generateArticleImages(category: string, slug: string, keyword: string, articleTitle: string, sections: ArticleSection[], addActivityLog?: (level: string, message: string, data?: any) => void): Promise<ImageGenerationResult>;
/**
 * Test image generation with a simple prompt
 */
export declare function testImageGeneration(): Promise<{
    success: boolean;
    message: string;
    imageUrl?: string;
}>;
//# sourceMappingURL=cloudflare-image-gen.d.ts.map