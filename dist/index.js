"use strict";
/**
 * SEO Generator V3 - Standalone Server
 * AI-powered article generation with Amazon affiliate integration
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const seo_generator_v3_1 = __importDefault(require("./routes/seo-generator-v3"));
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
// Middleware
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: 'v3', timestamp: new Date().toISOString() });
});
// V3 SEO Generator routes
app.use('/api/seo-generator-v3', seo_generator_v3_1.default);
// Start server
app.listen(PORT, () => {
    console.log(`[SEO Generator V3] Server running on port ${PORT}`);
    console.log(`[SEO Generator V3] API endpoint: http://localhost:${PORT}/api/seo-generator-v3`);
});
exports.default = app;
//# sourceMappingURL=index.js.map