import type { Page } from 'playwright';
import type { AgentObservation, PageState } from './types';
import { deriveWorkflowReachState } from './workflow';

/** Remove raw JS runtime error strings from evidence text shown to users / LLM. */
function stripJsNoiseFromEvidenceText(text: string): string {
  return text
    .replace(/(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)[^\n]{0,400}/gi, '')
    .replace(/Cannot read propert(?:y|ies) of (?:undefined|null)[^\n]{0,250}/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// dismissConsentBanner — auto-accepts cookie / GDPR banners before testing.
// Exported so the verifier can call it right after navigation.
// ─────────────────────────────────────────────────────────────────────────────

export async function dismissConsentBanner(page: Page): Promise<void> {
  const ACCEPT_RE = /^(accept all|accept cookies|accept|allow all|allow cookies|got it|i agree|ok|okay|agree|continue|close)\b/i;
  const REJECT_RE = /reject|decline|deny|necessary only|manage/i;
  try {
    const hasBanner = await page.evaluate(() => {
      const bannerSelectors = [
        '[id*="cookie"]', '[id*="consent"]', '[id*="gdpr"]',
        '[class*="cookie"]', '[class*="consent"]', '[class*="gdpr"]',
        '[class*="CookieBanner"]', '[class*="cookieBanner"]',
        '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
      ];
      return bannerSelectors.some((s) => {
        try { return !!document.querySelector(s); } catch { return false; }
      });
    }).catch(() => false);

    if (!hasBanner) return;

    const btns = page.locator('button, [role="button"], a').filter({ hasText: ACCEPT_RE });
    const count = await btns.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 3); i++) {
      const btn = btns.nth(i);
      const txt = await btn.textContent().catch(() => '');
      if (REJECT_RE.test(txt ?? '')) continue;
      const vis = await btn.isVisible({ timeout: 1_000 }).catch(() => false);
      if (!vis) continue;
      await btn.click().catch(() => {});
      console.log(`[evidence] Dismissed consent banner: "${(txt ?? '').trim()}"`);
      await page.waitForTimeout(500);
      return;
    }
  } catch { /* non-fatal */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// buildEvidenceSummary
// Constructs a structured evidence block for the verdict engine.
// ─────────────────────────────────────────────────────────────────────────────

export function buildEvidenceSummary(
  observations:   AgentObservation[],
  finalPageState: PageState,
  runApiCalls:    string[],
  startUrl:       string,
): string {
  const lines: string[] = ['--- Evidence Summary ---'];
  const workflowReach = deriveWorkflowReachState(observations, finalPageState);

  lines.push(`Surface reached: ${finalPageState.url}`);
  if (finalPageState.url !== startUrl) {
    lines.push(`URL changed during run: yes → ${finalPageState.url}`);
  } else {
    lines.push('URL changed during run: no');
  }

  const modalObs = observations.filter((o) => o.modalOpened);
  if (modalObs.length > 0) {
    const inputs = [...new Set(modalObs.flatMap((o) => o.newInputs ?? []))];
    lines.push(`Modal opened: yes${inputs.length > 0 ? ` — form with inputs: ${inputs.join(', ')}` : ''}`);
  } else {
    lines.push('Modal opened: no');
  }

  if (finalPageState.forms.length > 0) {
    const allInputs = finalPageState.forms.flatMap((f) =>
      f.inputs.map((i) => i.label || i.name || i.placeholder).filter(Boolean),
    );
    if (allInputs.length > 0) lines.push(`Form fields observed: ${allInputs.join(', ')}`);
  }

  const stepApiCalls = [...new Set(observations.flatMap((o) => o.apiCalls ?? []))];
  if (stepApiCalls.length > 0) {
    lines.push(`API activity (per-step): ${stepApiCalls.length} call(s)\n  ${stepApiCalls.slice(0, 5).join('\n  ')}`);
  }

  if (finalPageState.tableHeaders.length > 0) {
    lines.push(`Table/dashboard data: yes — headers: ${finalPageState.tableHeaders.join(', ')}`);
  } else {
    lines.push('Table/dashboard data: no');
  }

  const allBlockers = [...new Set([
    ...finalPageState.blockers,
    ...observations.map((o) => o.blockerDetected).filter((b): b is NonNullable<typeof b> => b != null) as string[],
  ])];
  if (allBlockers.length > 0) {
    lines.push(`Blockers encountered: ${allBlockers.join(', ')}`);
  }

  const noopCount = observations.filter((o) => o.isNoop).length;
  if (noopCount > 0) lines.push(`No-op actions: ${noopCount}`);

  const outcomeCounts = observations.reduce<Record<string, number>>((acc, o) => {
    const k = o.outcomeClass ?? 'unclassified';
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(`Workflow reach state: ${workflowReach}`);
  if (Object.keys(outcomeCounts).length > 0) {
    const list = Object.entries(outcomeCounts).map(([k, v]) => `${k}=${v}`).join(', ');
    lines.push(`Step outcome classes: ${list}`);
  }

  const allSignals = [...new Set(observations.flatMap((o) => o.visibleSignals ?? []))];
  if (allSignals.length > 0) {
    lines.push(`Visible signals observed: ${allSignals.join(', ')}`);
  }
  if (finalPageState.headings.length > 0) {
    lines.push(`Final page headings: ${finalPageState.headings.slice(0, 6).join(' | ')}`);
  }
  if (finalPageState.sectionLabels.length > 0) {
    lines.push(`Final section labels: ${finalPageState.sectionLabels.slice(0, 6).join(' | ')}`);
  }
  if (finalPageState.chartSignals.length > 0) {
    lines.push(`Chart/data signals: ${finalPageState.chartSignals.join(', ')}`);
  }

  lines.push('\n--- Interactive Agent ---');
  for (const obs of observations) {
    lines.push(`[${obs.step}] ${stripJsNoiseFromEvidenceText(obs.result ?? '')}`);
    if (obs.messages?.length) {
      lines.push(
        `  Page messages: ${obs.messages
          .map((m) => `[${m.type}] "${stripJsNoiseFromEvidenceText(m.text)}"`)
          .join(' | ')}`,
      );
    }
    if (obs.pageText && !obs.isNoop) {
      const cleanedText = obs.pageText
        .replace(/(?:TypeError|ReferenceError)[^\n]{0,200}\n?/g, '')
        .replace(/Cannot read propert(?:y|ies) of (?:undefined|null)[^\n]{0,150}\n?/gi, '')
        .trim();
      if (cleanedText.length > 10) lines.push(`  After: ${cleanedText.slice(0, 500)}`);
    }
  }

  const cleanedFinalText = finalPageState.visibleText
    .replace(/(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError)[^\n]{0,300}\n?/g, '')
    .replace(/Cannot read propert(?:y|ies) of (?:undefined|null)[^\n]{0,200}\n?/gi, '')
    .replace(/(?:at\s+\S+\s+\([^)]+\)\n?){2,}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  lines.push('\n--- Final Page State ---');
  if (cleanedFinalText.length > 20) {
    lines.push(`Final page content:\n${cleanedFinalText.slice(0, 1500)}`);
  }

  const uniqueRunCalls = [...new Set(runApiCalls)].slice(0, 12);
  if (uniqueRunCalls.length > 0) {
    lines.push(`\nAPI calls observed (full run):\n${uniqueRunCalls.join('\n')}`);
  }

  return lines.join('\n');
}
