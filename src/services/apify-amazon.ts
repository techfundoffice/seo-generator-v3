/**
 * Tier 2: Apify Amazon Product Service
 * Fallback when Amazon Creators API fails (e.g., AccessDeniedException)
 * Uses Apify Amazon Product Scraper actor
 *
 * Uses Apify's waitForFinish API — single blocking request, no polling.
 */

declare const fetch: typeof globalThis.fetch;

import { secrets } from "./doppler-secrets";

const APIFY_ACTOR_ID = "junglee~free-amazon-product-scraper";
const AMAZON_AFFILIATE_TAG = secrets.get("AMAZON_AFFILIATE_TAG") || process.env.AMAZON_AFFILIATE_TAG || "catsluvus03-20";
const AMAZON_MARKETPLACE = "www.amazon.com";
const APIFY_WAIT_SECS = 180; // Max seconds to wait for run completion

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

/**
 * Start an Apify run and wait for it to finish in a single request.
 * Returns the run ID if successful, throws otherwise.
 */
async function startRunAndWait(
  token: string,
  input: object
): Promise<string> {
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${token}&waitForFinish=${APIFY_WAIT_SECS}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Apify run failed: ${response.status} ${response.statusText} ${errText}`);
  }

  const data = await response.json();
  const runId = data.data?.id;
  const status = data.data?.status;

  if (!runId) throw new Error("No run ID returned from Apify");
  if (status !== "SUCCEEDED") throw new Error(`Apify run ${runId} finished with status: ${status}`);

  return runId;
}

/**
 * Fetch dataset items from a completed Apify run.
 */
async function fetchDatasetItems(token: string, runId: string): Promise<ApifyProductResult[]> {
  const response = await fetch(
    `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${token}`
  );
  if (!response.ok) throw new Error(`Failed to fetch dataset: ${response.status}`);
  return await response.json();
}

function mapToProduct(item: ApifyProductResult): AmazonProduct {
  return {
    asin: item.asin,
    title: item.title || "Unknown Product",
    url: `https://${AMAZON_MARKETPLACE}/dp/${item.asin}?tag=${AMAZON_AFFILIATE_TAG}`,
    imageUrl: item.thumbnailImage || "",
    price: item.price?.displayPrice || "Price not available",
    rating: item.stars || 0,
    reviewCount: item.reviewsCount || 0,
    isPrime: item.isPrime || false,
  };
}

export async function searchProductsViaApify(keyword: string, maxResults: number = 3): Promise<AmazonProduct[]> {
  const APIFY_TOKEN = getApifyToken();
  if (!APIFY_TOKEN) throw new Error("APIFY_TOKEN not configured");

  console.log(`[Apify Amazon] Searching for: "${keyword}" (max ${maxResults})`);

  try {
    const searchUrl = `https://${AMAZON_MARKETPLACE}/s?k=${encodeURIComponent(keyword)}`;
    const runId = await startRunAndWait(APIFY_TOKEN, {
      categoryUrls: [{ url: searchUrl }],
      maxItemsPerStartUrl: maxResults,
      maxPagesPerStartUrl: 1,
    });

    console.log(`[Apify Amazon] Run ${runId} succeeded`);
    const items = await fetchDatasetItems(APIFY_TOKEN, runId);
    console.log(`[Apify Amazon] Got ${items.length} results for "${keyword}"`);

    return items.slice(0, maxResults).map(mapToProduct);
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
    const runId = await startRunAndWait(APIFY_TOKEN, {
      startUrls: [{ url: `https://${AMAZON_MARKETPLACE}/dp/${asin}` }],
      country: "US",
      maxItemsPerStartUrl: 1,
      proxyConfiguration: { useApifyProxy: true },
    });

    const items = await fetchDatasetItems(APIFY_TOKEN, runId);
    if (items.length === 0) return null;

    const product = mapToProduct(items[0]);
    product.asin = product.asin || asin;
    product.url = `https://${AMAZON_MARKETPLACE}/dp/${product.asin || asin}?tag=${AMAZON_AFFILIATE_TAG}`;
    return product;
  } catch (error: any) {
    console.error(`[Apify Amazon] ASIN lookup error: ${error.message}`);
    return null;
  }
}

export function isApifyAvailable(): boolean {
  return !!getApifyToken();
}
