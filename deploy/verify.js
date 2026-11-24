#!/usr/bin/env node
'use strict';
/*
 * Damei (我的身体手帐) Google Play purchase verification endpoint.
 *
 * Zero npm dependencies. Requires Node.js >= 18 (global fetch, AbortController).
 *
 * Flow:
 *   POST /verify { productId, purchaseToken }
 *     -> service-account JWT (RS256, Node built-in crypto) exchanged for an
 *        OAuth2 access token (cached until ~60s before expiry)
 *     -> GET androidpublisher v3 purchases.products.get
 *     -> normalized JSON result
 *
 * Config (environment variables, all optional except the key file):
 *   PORT                    listen port                 (default 8377)
 *   HOST                    listen address              (default 127.0.0.1)
 *   SERVICE_ACCOUNT_KEY     path to service-account     (default /opt/damei-verify/service-account.json)
 *                           JSON key file
 *   PACKAGE_NAME            Android package name        (default com.karlmao.healthjournal.damei)
 *   ALLOWED_PRODUCT_IDS     comma-separated allowlist   (default damei_pro)
 *   UPSTREAM_TIMEOUT_MS     per-request upstream timeout(default 10000)
 *   MAX_BODY_BYTES          max request body size       (default 16384)
 *
 * The service-account JSON is read once at startup. The process exits with a
 * clear error if the file is missing or malformed, so systemd surfaces the
 * misconfiguration immediately instead of failing per-request.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG = {
  port: parseInt(process.env.PORT || '8377', 10),
  host: process.env.HOST || '127.0.0.1',
  keyPath: process.env.SERVICE_ACCOUNT_KEY || '/opt/damei-verify/service-account.json',
  packageName: process.env.PACKAGE_NAME || 'com.karlmao.healthjournal.damei',
  allowedProductIds: new Set(
    (process.env.ALLOWED_PRODUCT_IDS || 'damei_pro')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  ),
  upstreamTimeoutMs: parseInt(process.env.UPSTREAM_TIMEOUT_MS || '10000', 10),
  maxBodyBytes: parseInt(process.env.MAX_BODY_BYTES || '16384', 10),
  scope: 'https://www.googleapis.com/auth/androidpublisher',
  apiBase: 'https://androidpublisher.googleapis.com/androidpublisher/v3',
};

// ---------------------------------------------------------------------------
// Logging (tokens are always masked: first 6 + last 6 chars only)
// ---------------------------------------------------------------------------

function maskToken(token) {
  if (typeof token !== 'string') return '<non-string>';
  if (token.length <= 12) return `<len=${token.length}>`;
  return `${token.slice(0, 6)}...${token.slice(-6)}(len=${token.length})`;
}

function log(level, msg, fields) {
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields || {}),
  };
  const out = JSON.stringify(line);
  if (level === 'error') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

// ---------------------------------------------------------------------------
// Service account key
// ---------------------------------------------------------------------------

function loadServiceAccount(keyPath) {
  let raw;
  try {
    raw = fs.readFileSync(keyPath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read service account key file at ${keyPath}: ${err.message}`);
  }
  let key;
  try {
    key = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Service account key file at ${keyPath} is not valid JSON: ${err.message}`);
  }
  for (const field of ['client_email', 'private_key', 'token_uri']) {
    if (typeof key[field] !== 'string' || key[field].length === 0) {
      throw new Error(`Service account key file is missing required field "${field}"`);
    }
  }
  if (key.type !== 'service_account') {
    throw new Error(`Service account key file has unexpected type "${key.type}"`);
  }
  return key;
}

const serviceAccount = loadServiceAccount(CONFIG.keyPath);
log('info', 'service account loaded', { email: serviceAccount.client_email, keyPath: CONFIG.keyPath });

// ---------------------------------------------------------------------------
// OAuth2: JWT bearer exchange with in-memory token cache
// ---------------------------------------------------------------------------

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildJwtAssertion() {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: serviceAccount.client_email,
    scope: CONFIG.scope,
    aud: serviceAccount.token_uri,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(serviceAccount.private_key)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${unsigned}.${signature}`;
}

let tokenCache = { accessToken: null, expiresAtMs: 0 };
let tokenInFlight = null;

async function fetchAccessToken() {
  const assertion = buildJwtAssertion();
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.upstreamTimeoutMs);
  let res;
  try {
    res = await fetch(serviceAccount.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Token endpoint timed out after ${CONFIG.upstreamTimeoutMs}ms`);
      e.code = 'UPSTREAM_TIMEOUT';
      throw e;
    }
    const e = new Error(`Token endpoint request failed: ${err.message}`);
    e.code = 'UPSTREAM_NETWORK';
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`Token endpoint returned HTTP ${res.status}: ${truncate(text, 300)}`);
    e.code = 'UPSTREAM_AUTH';
    e.upstreamStatus = res.status;
    throw e;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const e = new Error('Token endpoint returned non-JSON response');
    e.code = 'UPSTREAM_BAD_RESPONSE';
    throw e;
  }
  if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number') {
    const e = new Error('Token endpoint response missing access_token/expires_in');
    e.code = 'UPSTREAM_BAD_RESPONSE';
    throw e;
  }
  // Cache until 60s before expiry (and at least 10s from now).
  const ttlMs = Math.max(10_000, data.expires_in * 1000 - 60_000);
  tokenCache = { accessToken: data.access_token, expiresAtMs: Date.now() + ttlMs };
  return data.access_token;
}

async function getAccessToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAtMs) {
    return tokenCache.accessToken;
  }
  if (!tokenInFlight) {
    tokenInFlight = fetchAccessToken().finally(() => {
      tokenInFlight = null;
    });
  }
  return tokenInFlight;
}

// ---------------------------------------------------------------------------
// Google Play Developer API: purchases.products.get
// ---------------------------------------------------------------------------

async function getPurchase(productId, purchaseToken) {
  const accessToken = await getAccessToken();
  const url =
    `${CONFIG.apiBase}/applications/${encodeURIComponent(CONFIG.packageName)}` +
    `/purchases/products/${encodeURIComponent(productId)}` +
    `/tokens/${encodeURIComponent(purchaseToken)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.upstreamTimeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error(`Play Developer API timed out after ${CONFIG.upstreamTimeoutMs}ms`);
      e.code = 'UPSTREAM_TIMEOUT';
      throw e;
    }
    const e = new Error(`Play Developer API request failed: ${err.message}`);
    e.code = 'UPSTREAM_NETWORK';
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (res.status === 404) {
    // Definitive: Google has no such purchase for this package/product/token.
    return { found: false };
  }
  if (res.status === 401 || res.status === 403) {
    // Access token rejected or service account lacks permission: drop the
    // cached token so the next request re-authenticates.
    tokenCache = { accessToken: null, expiresAtMs: 0 };
    const e = new Error(`Play Developer API returned HTTP ${res.status}: ${truncate(text, 300)}`);
    e.code = 'UPSTREAM_AUTH';
    e.upstreamStatus = res.status;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Play Developer API returned HTTP ${res.status}: ${truncate(text, 300)}`);
    e.code = 'UPSTREAM_ERROR';
    e.upstreamStatus = res.status;
    throw e;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const e = new Error('Play Developer API returned non-JSON response');
    e.code = 'UPSTREAM_BAD_RESPONSE';
    throw e;
  }
  return { found: true, purchase: data };
}

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

const PURCHASE_STATE_NAMES = { 0: 'purchased', 1: 'canceled', 2: 'pending' };
const ACK_STATE_NAMES = { 0: 'yet_to_be_acknowledged', 1: 'acknowledged' };
const CONSUMPTION_STATE_NAMES = { 0: 'yet_to_be_consumed', 1: 'consumed' };

function normalizeResult(productId, purchaseToken, result) {
  if (!result.found) {
    return {
      valid: false,
      reason: 'purchase_not_found',
      packageName: CONFIG.packageName,
      productId,
    };
  }
  const p = result.purchase;
  const purchaseState = typeof p.purchaseState === 'number' ? p.purchaseState : null;
  const acknowledgementState =
    typeof p.acknowledgementState === 'number' ? p.acknowledgementState : null;
  const consumptionState = typeof p.consumptionState === 'number' ? p.consumptionState : null;
  return {
    // A purchase only counts as owned when Google reports purchaseState 0.
    valid: purchaseState === 0,
    reason: purchaseState === 0 ? 'ok' : `purchase_state_${PURCHASE_STATE_NAMES[purchaseState] || 'unknown'}`,
    packageName: CONFIG.packageName,
    productId,
    purchaseState,
    purchaseStateName: PURCHASE_STATE_NAMES[purchaseState] || null,
    acknowledgementState,
    acknowledgementStateName: ACK_STATE_NAMES[acknowledgementState] || null,
    consumptionState,
    consumptionStateName: CONSUMPTION_STATE_NAMES[consumptionState] || null,
    orderId: typeof p.orderId === 'string' ? p.orderId : null,
    purchaseTimeMillis:
      typeof p.purchaseTimeMillis === 'string' || typeof p.purchaseTimeMillis === 'number'
        ? String(p.purchaseTimeMillis)
        : null,
    regionCode: typeof p.regionCode === 'string' ? p.regionCode : null,
    quantity: typeof p.quantity === 'number' ? p.quantity : null,
    kind: typeof p.kind === 'string' ? p.kind : null,
    // The token is deliberately NOT echoed back in the response.
    tokenMasked: maskToken(purchaseToken),
  };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function truncate(s, n) {
  return typeof s === 'string' && s.length > n ? s.slice(0, n) + '...' : s;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > CONFIG.maxBodyBytes) {
        const e = new Error(`Request body exceeds ${CONFIG.maxBodyBytes} bytes`);
        e.code = 'BODY_TOO_LARGE';
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function errorResponse(res, status, code, message) {
  sendJson(res, status, { valid: false, error: { code, message } });
}

async function handleVerify(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err.code === 'BODY_TOO_LARGE') {
      return errorResponse(res, 413, 'BODY_TOO_LARGE', err.message);
    }
    return errorResponse(res, 400, 'BAD_REQUEST', 'Failed to read request body');
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return errorResponse(res, 400, 'BAD_JSON', 'Request body must be valid JSON');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return errorResponse(res, 400, 'BAD_REQUEST', 'Request body must be a JSON object');
  }
  const { productId, purchaseToken } = payload;
  if (typeof productId !== 'string' || productId.length === 0 || productId.length > 128) {
    return errorResponse(res, 400, 'BAD_PRODUCT_ID', 'productId must be a non-empty string (max 128 chars)');
  }
  if (typeof purchaseToken !== 'string' || purchaseToken.length === 0 || purchaseToken.length > 4096) {
    return errorResponse(res, 400, 'BAD_PURCHASE_TOKEN', 'purchaseToken must be a non-empty string (max 4096 chars)');
  }
  if (!CONFIG.allowedProductIds.has(productId)) {
    return errorResponse(res, 400, 'PRODUCT_NOT_ALLOWED', `productId "${productId}" is not accepted by this endpoint`);
  }

  log('info', 'verify request', { productId, token: maskToken(purchaseToken) });
  const started = Date.now();
  try {
    const result = await getPurchase(productId, purchaseToken);
    const normalized = normalizeResult(productId, purchaseToken, result);
    log('info', 'verify result', {
      productId,
      token: maskToken(purchaseToken),
      valid: normalized.valid,
      reason: normalized.reason,
      ms: Date.now() - started,
    });
    return sendJson(res, 200, normalized);
  } catch (err) {
    log('error', 'verify failed', {
      productId,
      token: maskToken(purchaseToken),
      code: err.code || 'INTERNAL',
      message: err.message,
      ms: Date.now() - started,
    });
    if (err.code === 'UPSTREAM_TIMEOUT') {
      return errorResponse(res, 504, 'UPSTREAM_TIMEOUT', 'Timed out talking to Google; client should retry');
    }
    if (err.code === 'UPSTREAM_AUTH') {
      return errorResponse(res, 502, 'UPSTREAM_AUTH', 'Server could not authenticate to Google (check service account / Console permissions)');
    }
    if (err.code === 'UPSTREAM_NETWORK' || err.code === 'UPSTREAM_ERROR' || err.code === 'UPSTREAM_BAD_RESPONSE') {
      return errorResponse(res, 502, err.code, 'Upstream Google API error; client should retry');
    }
    return errorResponse(res, 500, 'INTERNAL', 'Unexpected server error');
  }
}

const startedAt = Date.now();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        status: 'ok',
        service: 'damei-verify',
        packageName: CONFIG.packageName,
        allowedProductIds: [...CONFIG.allowedProductIds],
        serviceAccountEmail: serviceAccount.client_email,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      });
    }
    if (req.method === 'POST' && url.pathname === '/verify') {
      return await handleVerify(req, res);
    }
    if (url.pathname === '/verify' || url.pathname === '/health') {
      return errorResponse(res, 405, 'METHOD_NOT_ALLOWED', `${req.method} not allowed on ${url.pathname}`);
    }
    return errorResponse(res, 404, 'NOT_FOUND', 'Unknown path');
  } catch (err) {
    log('error', 'unhandled request error', { message: err.message, stack: err.stack });
    if (!res.headersSent) {
      return errorResponse(res, 500, 'INTERNAL', 'Unexpected server error');
    }
    res.end();
  }
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

server.listen(CONFIG.port, CONFIG.host, () => {
  log('info', 'listening', {
    host: CONFIG.host,
    port: CONFIG.port,
    packageName: CONFIG.packageName,
    allowedProductIds: [...CONFIG.allowedProductIds],
  });
});

function shutdown(signal) {
  log('info', 'shutting down', { signal });
  server.close(() => process.exit(0));
  // Force-exit if connections hang.
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
