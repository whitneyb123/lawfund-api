/**
 * FRONTEND CHANGE — replace your existing callClaude() with this.
 *
 * Before: called api.anthropic.com directly (API key exposed in source)
 * After:  calls /api/claude on your Vercel deployment (API key stays server-side)
 *
 * During local development, point this at localhost:
 *   const API_URL = 'http://localhost:3000/api/claude';
 *
 * In production (after deploying to Vercel), use a relative path:
 *   const API_URL = '/api/claude';
 *
 * If your frontend (GitHub Pages) and backend (Vercel) are on different domains,
 * use the full Vercel URL:
 *   const API_URL = 'https://your-project.vercel.app/api/claude';
 */
const API_URL = 'https://your-project.vercel.app/api/claude';

async function callClaude(systemPrompt, userMessage) {

  // AbortController lets us cancel if the user navigates away or
  // if we want to add a "stop generating" button later
  const controller = new AbortController();

  // Client-side timeout as a safety net — the server has its own,
  // but this prevents the UI from spinning forever if the network drops
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(API_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json' },
      // Send only what the server needs — no model name, no API key
      body: JSON.stringify({ systemPrompt, userMessage }),
    });

    clearTimeout(timeout);

    // Parse the response body regardless of status code,
    // because our server always returns JSON (including errors)
    const data = await response.json();

    if (!response.ok) {
      // Surface the server's error message directly in the UI
      throw new Error(data.error ?? `Request failed with status ${response.status}`);
    }

    return data.text;

  } catch (err) {
    clearTimeout(timeout);

    if (err.name === 'AbortError') {
      throw new Error('Request timed out — please try again.');
    }

    // Re-throw so each call site (decodeOffer, compareOffers, generateAppeal)
    // can handle it in its own catch block as before
    throw err;
  }
}
