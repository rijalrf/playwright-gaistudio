const fs = require('fs');
const path = require('path');

// Simple .env parser to avoid requiring external dotenv package if not installed
function loadEnv() {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...vals] = trimmed.split('=');
        const k = key.trim();
        const v = vals.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  }
}

loadEnv();

const DEFAULT_API_KEY = process.env.API_KEY || process.env.AISTUDION_API_KEY || process.env.AISTUDIO_API_KEY || process.env.AUSTUDIO_API_KEY || '';

/**
 * Middleware to protect API routes with API Key
 */
function apiKeyAuth(req, res, next) {
  // Extract API key from various common locations
  let clientKey = null;

  // 1. Header 'x-api-key'
  if (req.headers['x-api-key']) {
    clientKey = req.headers['x-api-key'];
  }
  // 2. Authorization header: Bearer <key> or ApiKey <key>
  else if (req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && (parts[0].toLowerCase() === 'bearer' || parts[0].toLowerCase() === 'apikey')) {
      clientKey = parts[1];
    } else {
      clientKey = req.headers.authorization;
    }
  }
  // 3. Query string '?key=...' or '?api_key=...'
  else if (req.query.key) {
    clientKey = req.query.key;
  }
  else if (req.query.api_key) {
    clientKey = req.query.api_key;
  }

  const expectedKey = process.env.API_KEY || process.env.AISTUDION_API_KEY || process.env.AISTUDIO_API_KEY || process.env.AUSTUDIO_API_KEY || DEFAULT_API_KEY;

  if (!clientKey) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Missing API Key.',
      message: 'Sertakan API Key via header "x-api-key", "Authorization: Bearer <KEY>", atau query "?key=<KEY>" / "?api_key=<KEY>".'
    });
  }

  if (clientKey !== expectedKey) {
    return res.status(403).json({
      success: false,
      error: 'Forbidden: Invalid API Key.',
      message: 'API Key yang Anda berikan tidak cocok. Periksa konfigurasi di file .env atau hubungi admin.'
    });
  }

  next();
}

module.exports = {
  loadEnv,
  apiKeyAuth,
  DEFAULT_API_KEY
};
