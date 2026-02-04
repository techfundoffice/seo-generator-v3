/**
 * SEO Generator V3 - Standalone Server
 * AI-powered article generation with Amazon affiliate integration
 */

import express from 'express';
import seoGeneratorV3Router from './routes/seo-generator-v3';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: 'v3', timestamp: new Date().toISOString() });
});

// V3 SEO Generator routes
app.use('/api/seo-generator-v3', seoGeneratorV3Router);

// Start server
app.listen(PORT, () => {
  console.log(`[SEO Generator V3] Server running on port ${PORT}`);
  console.log(`[SEO Generator V3] API endpoint: http://localhost:${PORT}/api/seo-generator-v3`);
});

export default app;
