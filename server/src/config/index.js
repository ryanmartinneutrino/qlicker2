import dotenv from 'dotenv';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../../.env'), quiet: true });

const nodeEnv = process.env.NODE_ENV || 'development';
const runtimeJwtSecret = crypto.randomBytes(32).toString('hex');
const runtimeJwtRefreshSecret = crypto.randomBytes(32).toString('hex');
const jwtSecret = process.env.JWT_SECRET || runtimeJwtSecret;
const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || runtimeJwtRefreshSecret;

function parseBooleanEnv(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseOptionalBooleanEnv(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function parseNonNegativeIntEnv(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readVersionFromFile(filePath) {
  try {
    const value = readFileSync(filePath, 'utf8').trim();
    return value || '';
  } catch {
    return '';
  }
}

function readVersionFromPackageJson(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    const version = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
    if (!version) return '';
    return version.startsWith('v') ? version : `v${version}`;
  } catch {
    return '';
  }
}

const appVersion = (process.env.APP_VERSION || '').trim()
  || readVersionFromFile(resolve(__dirname, '../../../VERSION'))
  || readVersionFromPackageJson(resolve(__dirname, '../../package.json'))
  || 'dev';

if (nodeEnv === 'production') {
  if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
    throw new Error('JWT_SECRET and JWT_REFRESH_SECRET must be set in production');
  }
}

export default {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/qlicker',
  jwtSecret,
  jwtRefreshSecret,
  rootUrl: process.env.ROOT_URL || 'http://localhost:3000',
  mailUrl: process.env.MAIL_URL || '',
  redisUrl: process.env.REDIS_URL || '',
  appVersion,
  enableApiDocs: parseOptionalBooleanEnv(process.env.ENABLE_API_DOCS, nodeEnv !== 'production'),
  mongoMaxPoolSize: parseNonNegativeIntEnv(process.env.MONGO_MAX_POOL_SIZE, 25),
  mongoMinPoolSize: parseNonNegativeIntEnv(process.env.MONGO_MIN_POOL_SIZE, 0),
  mongoServerSelectionTimeoutMs: parseNonNegativeIntEnv(
    process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    10000
  ),
  mongoSocketTimeoutMs: parseNonNegativeIntEnv(process.env.MONGO_SOCKET_TIMEOUT_MS, 45000),
  mongoConnectRetries: parseNonNegativeIntEnv(process.env.MONGO_CONNECT_RETRIES, 6),
  mongoConnectRetryDelayMs: parseNonNegativeIntEnv(process.env.MONGO_CONNECT_RETRY_DELAY_MS, 2000),
  nodeEnv,
  disableRateLimits: parseBooleanEnv(process.env.DISABLE_RATE_LIMITS)
    || parseBooleanEnv(process.env.RATE_LIMIT_DISABLED),
};
