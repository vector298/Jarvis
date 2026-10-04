import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // no .env file, fall through to the real environment
}

const env = process.env;
const port = Number(env.PORT) || 3000;

export const config = {
  root,
  port,
  host: env.HOST || '127.0.0.1',
  publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: path.resolve(root, env.DATA_DIR || 'data'),
  demo: env.JARVIS_DEMO === '1' || process.argv.includes('--demo'),
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    // only for pointing tests at a local stand-in for googleapis.com
    apiRoot: env.GOOGLE_API_ROOT_URL || undefined,
  },
  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',
    apiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, ''),
    // "Bruce=123456789,Team=-1001234567890"
    seedContacts: env.TELEGRAM_CONTACTS || '',
  },
  llm: {
    key: env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || '',
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  },
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 200) * 1024 * 1024,
};

config.google.redirectUri = `${config.publicUrl}/auth/google/callback`;
