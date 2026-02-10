interface AmazonProduct {
    asin: string;
    title: string;
    price: string;
    priceValue: number;
    imageUrl: string;
    detailPageUrl: string;
    availability: string;
    rating?: number;
    reviewCount?: number;
    features?: string[];
}
interface AmazonSearchResult {
    products: AmazonProduct[];
    totalResults: number;
    searchUrl: string;
}
declare const AMAZON_TAG: string;
export declare function searchAmazonProducts(keywords: string, category?: string, itemCount?: number): Promise<AmazonSearchResult>;
export declare function getAmazonProduct(asin: string): Promise<AmazonProduct | null>;
export declare function buildAmazonAffiliateUrl(productName: string): string;
export declare function buildAmazonAsinUrl(asin: string): string;
export { AMAZON_TAG };
//# sourceMappingURL=amazon-products.d.ts.map