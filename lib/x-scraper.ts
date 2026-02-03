/**
 * X (Twitter) API v2 — fetch profile bio + recent tweets for a handle.
 * Requires X_BEARER_TOKEN in environment (free Basic tier is sufficient).
 *
 * Docs: https://developer.x.com/en/docs/x-api/users/lookup/api-reference
 *       https://developer.x.com/en/docs/x-api/tweets/timelines/api-reference
 */

const MAX_TWEETS = 6;
const MAX_CHARS  = 2_500;
const BASE       = 'https://api.twitter.com/2';

function normaliseHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '')
    .replace(/^@/, '')
    .split('/')[0]
    .split('?')[0]
    .trim();
}

function getBearer(): string {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error('X_BEARER_TOKEN is not set');
  return token;
}

async function xFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${getBearer()}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`X API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

interface XUser {
  id:          string;
  name:        string;
  username:    string;
  description: string;
}

interface XTweet {
  id:   string;
  text: string;
}

/**
 * Fetches profile bio + up to MAX_TWEETS recent tweets for a given X handle.
 * Returns formatted text ready for LLM context, or '' on any error.
 */
export async function fetchXProfileText(rawHandle: string): Promise<string> {
  const handle = normaliseHandle(rawHandle);
  if (!handle) return '';

  console.log(`[x-scraper] Fetching X profile via API: @${handle}`);

  try {
    // 1. Resolve handle → user ID + bio
    const userRes = await xFetch<{ data: XUser }>(
      `/users/by/username/${handle}?user.fields=description`,
    );
    const user = userRes.data;
    if (!user) {
      console.warn(`[x-scraper] User @${handle} not found`);
      return '';
    }

    console.log(`[x-scraper] Resolved @${handle} → id ${user.id}`);

    // 2. Fetch recent tweets (exclude replies and retweets)
    const tweetsRes = await xFetch<{ data?: XTweet[] }>(
      `/users/${user.id}/tweets` +
      `?max_results=${MAX_TWEETS}` +
      `&exclude=replies,retweets` +
      `&tweet.fields=text`,
    );
    const tweets = tweetsRes.data ?? [];

    console.log(`[x-scraper] Bio: ${user.description?.length ?? 0} chars, Tweets: ${tweets.length}`);

    // 3. Build combined context
    const parts: string[] = [];
    if (user.description?.trim()) {
      parts.push(`Bio: ${user.description.trim()}`);
    }
    if (tweets.length > 0) {
      parts.push(`Recent tweets:\n${tweets.map((t) => t.text.trim()).join('\n---\n')}`);
    }

    if (parts.length === 0) return '';

    const combined = parts.join('\n\n');
    console.log(`[x-scraper] Combined X content: ${combined.length} chars`);
    return combined.slice(0, MAX_CHARS);

  } catch (e) {
    console.warn('[x-scraper] X API failed (non-fatal):', e instanceof Error ? e.message : e);
    return '';
  }
}
