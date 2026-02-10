/**
 * Tier 2: Apify Amazon Product Service
 * Fallback when Amazon Creators API fails (e.g., AccessDeniedException)
 * Uses Apify Amazon Product Scraper actor
 */
export interface AmazonProduct {
    asin: string;
    title: string;
    url: string;
    imageUrl: string;
    price: string;
    rating: number;
    reviewCount: number;
    isPrime: boolean;
}
export declare function searchProductsViaApify(keyword: string, maxResults?: number): Promise<AmazonProduct[]>;
export declare function getProductByAsinViaApify(asin: string): Promise<AmazonProduct | null>;
export declare function isApifyAvailable(): boolean;
//# sourceMappingURL=apify-amazon.d.ts.map