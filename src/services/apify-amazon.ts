/**
 * Tier 2: Apify Amazon Product Service
 * Fallback when Amazon Creators API fails (e.g., AccessDeniedException)
 * Uses Apify Amazon Product Scraper actor
 */

import { secrets } from "./doppler-secrets";

const APIFY_ACTOR_ID = "junglee/amazon-crawler";
const AMAZON_AFFILIATE_TAG = secrets.get("AMAZON_AFFILIATE_TAG") || process.env.AMAZON_AFFILIATE_TAG || "catsluvus03-20";
const AMAZON_MARKETPLACE = "www.amazon.com";

interface ApifyProductResult {
  asin: string;
  title: string;
  thumbnailImage: string;
  price?: { value: number; currency: string; displayPrice: string };
  stars?: number;
  reviewsCount?: number;
  isPrime?: boolean;
}

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

function getApifyToken(): string | undefined {
  return secrets.get("APIFY_TOKEN") || process.env.APIFY_TOKEN;
}

export async function searchProductsViaApify(keyword: string, maxResults: number = 5): Promise<AmazonProduct[]> {
  const APIFY_TOKEN = getApifyToken();
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN not configured");

  console.log(`[Apify Amazon] Searching for: "${keyword}" (max ${maxResults})`);

  try {
    const runResponse = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search: keyword,
          searchType: "keyword",
          country: "US",
          maxItemsPerStartUrl: maxResults,
          proxyConfiguration: { useApifyProxy: true }
        })
      }
    );

    if (!runResponse.ok) throw new Error(`Apify run failed: ${runResponse.status} ${runResponse.statusText}`);
    const runData = await runResponse.json();
    const runId = runData.data?.id;
    if (!runId) throw new Error("No run ID returned");

    console.log(`[Apify Amazon] Run started: ${runId}`);

    // Poll for completion (max 60 seconds)
    let status = "RUNNING";
    let attempts = 0;
    while (status === "RUNNING" && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const statusResponse = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
      const statusData = await statusResponse.json();
      status = statusData.data?.status || "FAILED";
      attempts++;
    }

    if (status !== "SUCCEEDED") throw new Error(`Apify run did not succeed: ${status}`);

    const datasetResponse = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`
    );
    const items: ApifyProductResult[] = await datasetResponse.json();
    console.log(`[Apify Amazon] Got ${items.length} results for "${keyword}"`);

    return items.slice(0, maxResults).map(item => ({
      asin: item.asin,
      title: item.title || "Unknown Product",
      url: `https://${AMAZON_MARKETPLACE}/dp/${item.asin}?tag=${AMAZON_AFFILIATE_TAG}`,
      imageUrl: item.thumbnailImage || "",
      price: item.price?.displayPrice || "Price not available",
      rating: item.stars || 0,
      reviewCount: item.reviewsCount || 0,
      isPrime: item.isPrime || false
    }));
  } catch (error: any) {
    console.error(`[Apify Amazon] Search error: ${error.message}`);
    throw error;
  }
}

export async function getProductByAsinViaApify(asin: string): Promise<AmazonProduct | null> {
  const APIFY_TOKEN = getApifyToken();
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN not configured");

  console.log(`[Apify Amazon] Fetching product ASIN: ${asin}`);

  try {
    const runResponse = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrls: [{ url: `https://${AMAZON_MARKETPLACE}/dp/${asin}` }],
          country: "US",
          maxItemsPerStartUrl: 1,
          proxyConfiguration: { useApifyProxy: true }
        })
      }
    );

    if (!runResponse.ok) return null;
    const runData = await runResponse.json();
    const runId = runData.data?.id;

    let status = "RUNNING";
    let attempts = 0;
    while (status === "RUNNING" && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const statusResponse = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`);
      const statusData = await statusResponse.json();
      status = statusData.data?.status || "FAILED";
      attempts++;
    }

    if (status !== "SUCCEEDED") return null;

    const datasetResponse = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_TOKEN}`
    );
    const items: ApifyProductResult[] = await datasetResponse.json();

    if (items.length === 0) return null;
    const item = items[0];

    return {
      asin: item.asin || asin,
      title: item.title || "Unknown Product",
      url: `https://${AMAZON_MARKETPLACE}/dp/${item.asin || asin}?tag=${AMAZON_AFFILIATE_TAG}`,
      imageUrl: item.thumbnailImage || "",
      price: item.price?.displayPrice || "Price not available",
      rating: item.stars || 0,
      reviewCount: item.reviewsCount || 0,
      isPrime: item.isPrime || false
    };
  } catch (error: any) {
    console.error(`[Apify Amazon] ASIN lookup error: ${error.message}`);
    return null;
  }
}

export function isApifyAvailable(): boolean {
  return !!getApifyToken();
}
