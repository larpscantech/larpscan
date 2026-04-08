/**
 * Centralized LLM client factory.
 *
 * Preference order:
 *  1. OPENROUTER_API_KEY  → OpenRouter (https://openrouter.ai/api/v1)
 *  2. OPENAI_API_KEY      → OpenAI direct
 *
 * OpenRouter is OpenAI-SDK-compatible — same request/response shape, just a
 * different base URL and provider-prefixed model names (e.g. "openai/gpt-4o").
 *
 * Model name helpers are exported so callers never hard-code provider strings.
 */

import OpenAI from 'openai';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// ── Model name constants ───────────────────────────────────────────────────────
// Resolved at module load so model strings stay consistent across all callers.

function resolveModel(openaiName: string): string {
  const useOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  return useOpenRouter ? `openai/${openaiName}` : openaiName;
}

export const MODEL_LARGE = resolveModel('gpt-4o');       // complex reasoning, plan generation
export const MODEL_SMALL = resolveModel('gpt-4o-mini');  // fast adaptive decisions

// ── Shared lazy singleton ──────────────────────────────────────────────────────

let _llmClient: OpenAI | null = null;

/**
 * Returns a singleton OpenAI-compatible client.
 * Prefers OpenRouter when OPENROUTER_API_KEY is set; falls back to OpenAI.
 */
export function getLLMClient(): OpenAI {
  if (_llmClient) return _llmClient;

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const openaiKey     = process.env.OPENAI_API_KEY;

  if (openrouterKey) {
    _llmClient = new OpenAI({
      apiKey:  openrouterKey,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': 'https://larpscan.sh',
        'X-Title':      'LarpScan',
      },
    });
    return _llmClient;
  }

  if (openaiKey) {
    _llmClient = new OpenAI({ apiKey: openaiKey });
    return _llmClient;
  }

  throw new Error('No LLM API key configured. Set OPENROUTER_API_KEY or OPENAI_API_KEY.');
}

/**
 * Returns the correct OpenAI client for TTS (text-to-speech).
 * OpenRouter does NOT proxy OpenAI's TTS-1 model, so TTS always uses OpenAI
 * directly. Returns null when no OpenAI key is available (voice is disabled).
 */
export function getTTSClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}
