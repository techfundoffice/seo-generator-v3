# SEO Generator V3

Standalone AI-powered SEO article generator with Amazon affiliate integration.

## Features

- 🤖 AI-powered article generation (Cloudflare AI)
- 🖼️ AI image generation for articles
- 🛒 Amazon affiliate product integration
- 📊 SEO optimization and scoring
- 🔍 Research-based content enhancement
- 📈 Google Search Console integration ready

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Configure your API keys in .env

# Start development server
npm run dev
```

## API Endpoints

### Stats
```
GET /api/seo-generator-v3/stats
```

### Generate Article
```
POST /api/seo-generator-v3/generate
{
  "keyword": "best cat carrier for travel",
  "category": "cat-carriers-travel-products"
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| CLOUDFLARE_ACCOUNT_ID | Cloudflare account ID |
| CLOUDFLARE_API_TOKEN | Cloudflare API token |
| AMAZON_AFFILIATE_TAG | Amazon Associates tag |
| KV_NAMESPACE_ID | Cloudflare KV namespace ID |

## Project Structure

```
seo-generator-v3/
├── src/
│   ├── routes/          # API route handlers
│   ├── services/        # Business logic
│   ├── types/           # TypeScript types
│   ├── config/          # Configuration
│   ├── data/            # Static data (keywords, etc.)
│   └── index.ts         # Entry point
├── tests/               # Test files
├── docs/                # Documentation
└── package.json
```

## License

MIT
