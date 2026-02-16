/**
 * api/claude.js
 *
 * Vercel serverless function — proxies requests to Anthropic.
 *
 * Why a proxy instead of calling Anthropic from the frontend?
 *   1. The API key never leaves the server environment
 *   2. We can enforce rate limits, timeouts, and input validation centrally
 *   3. We can change models or add logging without touching the frontend
 *
 * Deploy to Vercel, then set ANTHROPIC_API_KEY in:
 *   Vercel Dashboard → Your Project → Settings → Environment Variables
 */

const { checkRateLimit } = require('./rateLimit');


// How long we'll wait for Anthropic before giving up.
// Vercel hobby plan max is 10s — keep this under that.
const TIMEOUT_MS = 25000;

// The only model we allow — prevents the client from
// switching to a more expensive model via request manipulation.
const ALLOWED_MODEL = 'claude-3-5-haiku-20241022';

module.exports = async function handler(req, res) {

 // ── 1. CORS + PREFLIGHT ───────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── 3. RATE LIMIT ─────────────────────────────────────────────────────────
  // x-forwarded-for is set by Vercel's edge network — always prefer it over
  // req.socket.remoteAddress which will be Vercel's internal IP.
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ?? 'unknown';
  const { allowed, remaining, retryAfter } = checkRateLimit(ip);

  // Always send rate limit headers so the client can see its budget
  res.setHeader('X-RateLimit-Remaining', remaining);

  if (!allowed) {
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      error: `Rate limit exceeded. Try again in ${retryAfter} seconds.`
    });
  }

  // ── 4. INPUT VALIDATION ───────────────────────────────────────────────────
  const { systemPrompt, userMessage } = req.body ?? {};

  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return res.status(400).json({ error: 'systemPrompt is required and must be a string.' });
  }

  if (!userMessage || typeof userMessage !== 'string') {
    return res.status(400).json({ error: 'userMessage is required and must be a string.' });
  }

  // Prevent absurdly large payloads from burning tokens
  if (systemPrompt.length > 4000) {
    return res.status(400).json({ error: 'systemPrompt exceeds maximum length of 4000 characters.' });
  }

  if (userMessage.length > 4000) {
    return res.status(400).json({ error: 'userMessage exceeds maximum length of 4000 characters.' });
  }

  // ── 5. API KEY CHECK ──────────────────────────────────────────────────────
  // Fail fast with a clear message if the env var isn't set,
  // rather than letting it surface as a cryptic Anthropic 401.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY environment variable is not set');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  // ── 6. CALL ANTHROPIC WITH TIMEOUT ───────────────────────────────────────
  try {
    // AbortController lets us cancel the fetch if it runs too long
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      ALLOWED_MODEL,
        max_tokens: 1500,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userMessage }],
      }),
    });

    clearTimeout(timeout); // Don't let the timer fire after a successful response

    // ── 7. HANDLE ANTHROPIC ERRORS ───────────────────────────────────────
    if (!anthropicRes.ok) {
      const errorBody = await anthropicRes.json().catch(() => ({}));

      // Log the full error server-side for debugging
      console.error('Anthropic API error:', anthropicRes.status, errorBody);

      // Return a safe, generic message to the client — never forward
      // raw Anthropic error bodies which may contain internal details
      const clientMessage = anthropicRes.status === 429
        ? 'The AI service is temporarily busy. Please try again in a moment.'
        : 'The AI service returned an error. Please try again.';

      return res.status(502).json({ error: clientMessage });
    }

    // ── 8. EXTRACT AND RETURN JUST THE TEXT ──────────────────────────────
    const data = await anthropicRes.json();
    const text = data?.content?.[0]?.text;

    if (!text) {
      console.error('Unexpected Anthropic response shape:', JSON.stringify(data));
      return res.status(502).json({ error: 'Unexpected response from AI service.' });
    }

    // Return only the text — never forward the full Anthropic response
    // which contains usage stats, model info, and internal IDs
    return res.status(200).json({ text });

  } catch (err) {

    // ── 9. TIMEOUT AND NETWORK ERRORS ────────────────────────────────────
    if (err.name === 'AbortError') {
      console.error('Anthropic request timed out after', TIMEOUT_MS, 'ms');
      return res.status(504).json({ error: 'Request timed out. Please try again.' });
    }

    // Catch-all — log the real error, return nothing sensitive to the client
    console.error('Unexpected error in /api/claude:', err.message);
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
};
