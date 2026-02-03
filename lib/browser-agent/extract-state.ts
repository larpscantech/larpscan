import type { Page } from 'playwright';

// ─────────────────────────────────────────────────────────────────────────────
// StructuredPageState — what a human tester sees when they look at the page.
//
// Every field exists because the LLM was previously blind to it, causing a
// specific failure:
//   forms.fields     → agent couldn't see which fields were filled/empty
//   forms.errors     → agent couldn't see "already exists" inline errors
//   forms.submitBtn  → agent couldn't find the Preview/Create button
//   toasts           → agent missed success/error notifications
//   modals           → agent didn't know a dialog was blocking interaction
//   buttons          → agent couldn't tell which buttons were enabled
//   loadingVisible   → agent clicked during loading spinners
//   walletState      → agent re-clicked "Connect Wallet" unnecessarily
// ─────────────────────────────────────────────────────────────────────────────

export interface FormField {
  label: string;
  selector: string;
  value: string;
  filled: boolean;
  type: string;
}

export interface FormInfo {
  fields: FormField[];
  submitButton: { text: string; enabled: boolean } | null;
  errors: string[];
}

export interface ButtonInfo {
  text: string;
  enabled: boolean;
  primary: boolean;
}

export interface ModalInfo {
  title: string;
  hasInputs: boolean;
}

export interface ToastInfo {
  type: 'error' | 'success' | 'warning' | 'info';
  text: string;
}

export interface StructuredPageState {
  url: string;
  forms: FormInfo[];
  buttons: ButtonInfo[];
  modals: ModalInfo[];
  toasts: ToastInfo[];
  headings: string[];
  visibleText: string;
  loadingVisible: boolean;
  walletState: 'connected' | 'disconnected' | 'connecting';
}

/**
 * Single page.evaluate call that extracts everything a human tester would see.
 * Runs in the browser context — must be self-contained (no Node imports).
 */
export async function extractStructuredState(page: Page): Promise<StructuredPageState> {
  const url = page.url();

  const extracted = await page.evaluate(() => {
    // ── Visibility helper ──────────────────────────────────────────────
    function isVisible(el: Element): boolean {
      const s = window.getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
      const r = (el as HTMLElement).getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function getText(el: Element): string {
      return ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
    }

    // ── Forms ──────────────────────────────────────────────────────────
    const forms: Array<{
      fields: Array<{ label: string; selector: string; value: string; filled: boolean; type: string }>;
      submitButton: { text: string; enabled: boolean } | null;
      errors: string[];
    }> = [];

      const allInputs = Array.from(document.querySelectorAll(
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]), textarea, select',
    )).filter(isVisible) as HTMLInputElement[];

    if (allInputs.length > 0) {
      const fields = allInputs.slice(0, 20).map((inp) => {
        const ph = inp.placeholder ?? '';
        const nm = inp.name ?? '';
        const id = inp.id ?? '';

        // Resolve the human-readable label using multiple strategies:
        // 1. aria-label attribute
        // 2. <label for="id"> element text
        // 3. aria-labelledby referenced element text
        // 4. Closest wrapping element's first text-only child (React pattern)
        // 5. Previous sibling text node
        // 6. Fall back to placeholder / name / id
        let resolvedLabel = inp.getAttribute('aria-label') ?? '';
        if (!resolvedLabel && id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl) resolvedLabel = (lbl as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
        }
        if (!resolvedLabel) {
          const labelledBy = inp.getAttribute('aria-labelledby');
          if (labelledBy) {
            const lbl = document.getElementById(labelledBy);
            if (lbl) resolvedLabel = (lbl as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
          }
        }
        if (!resolvedLabel) {
          // Walk up to find a wrapping group, look for the first visible text child
          let el: Element | null = inp.parentElement;
          for (let i = 0; i < 4 && el; i++) {
            const textNodes = Array.from(el.childNodes).filter(
              (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 1,
            );
            if (textNodes.length > 0) {
              resolvedLabel = (textNodes[0].textContent ?? '').trim();
              break;
            }
            // Also check span/div/label children that contain only text (no inputs)
            const textEls = Array.from(el.children).filter(
              (c) => !['INPUT','TEXTAREA','SELECT','BUTTON'].includes(c.tagName) && (c as HTMLElement).innerText.trim().length > 1 && (c as HTMLElement).innerText.trim().length < 60,
            );
            if (textEls.length > 0) {
              resolvedLabel = (textEls[0] as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
              break;
            }
            el = el.parentElement;
          }
        }
        // Final fallback to placeholder / name / id / type
        const label = resolvedLabel || ph || nm || id || inp.type || 'input';

        const selector = id
          ? `#${CSS.escape(id)}`
          : ph
            ? `[placeholder="${CSS.escape(ph)}"]`
            : nm
              ? `[name="${CSS.escape(nm)}"]`
              : 'input';
        const value = (inp.value ?? '').trim();
        return {
          label: label.slice(0, 80),
          selector,
          value: value.slice(0, 100),
          filled: value.length > 0,
          type: inp.type || 'text',
        };
      });

      // Find the most likely submit button near the form
      const submitCandidates = Array.from(document.querySelectorAll(
        'button, [role="button"], input[type="submit"], a[class*="button" i], a[class*="btn" i]',
      )).filter(isVisible);

      const submitKw = /preview|create|deploy|mint|launch|submit|confirm|publish|generate|save|next|continue|start|mine|claim|stake|swap|send|buy|sell/i;
      let submitButton: { text: string; enabled: boolean } | null = null;
      for (const btn of submitCandidates) {
        const btnText = getText(btn);
        if (submitKw.test(btnText.toLowerCase())) {
          const disabled = (btn as HTMLButtonElement).disabled || btn.getAttribute('aria-disabled') === 'true';
          submitButton = { text: btnText.slice(0, 60), enabled: !disabled };
          break;
        }
      }

      // Find error messages near form elements
      const errorEls = Array.from(document.querySelectorAll(
        '[role="alert"], [class*="error" i], [class*="invalid" i], [class*="danger" i], ' +
        'p[class*="helper" i], [class*="fieldError" i], [class*="form-error" i], [class*="validation" i]',
      )).filter(isVisible);
      const errors: string[] = [];
      const seenErrors = new Set<string>();
      for (const el of errorEls) {
        const t = getText(el);
        if (t.length >= 6 && t.length <= 300 && !seenErrors.has(t)) {
          seenErrors.add(t);
          errors.push(t);
        }
      }

      forms.push({ fields, submitButton, errors: errors.slice(0, 5) });
    }

    // ── Buttons ────────────────────────────────────────────────────────
    const buttonEls = Array.from(document.querySelectorAll(
      'button, [role="button"], input[type="submit"], a[class*="button" i], a[class*="btn" i]',
    )).filter(isVisible);
    const buttons = buttonEls.slice(0, 15).map((btn) => {
      const text = getText(btn);
      const disabled = (btn as HTMLButtonElement).disabled || btn.getAttribute('aria-disabled') === 'true';
      const cls = (btn.className ?? '').toLowerCase();
      const primary = /primary|cta|main|submit|action/i.test(cls) ||
        btn.tagName === 'BUTTON' && (btn as HTMLButtonElement).type === 'submit';
      return { text: text.slice(0, 60), enabled: !disabled, primary };
    }).filter((b) => b.text.length > 0);

    // ── Modals ─────────────────────────────────────────────────────────
    const modalEls = Array.from(document.querySelectorAll(
      'dialog, [role="dialog"], [role="alertdialog"], [class*="modal" i][class*="open" i], [class*="modal" i][class*="show" i], [class*="overlay" i][class*="active" i]',
    )).filter(isVisible);
    const modals = modalEls.slice(0, 3).map((m) => {
      const heading = m.querySelector('h1, h2, h3, h4, [class*="title" i]');
      const title = heading ? getText(heading) : getText(m).slice(0, 80);
      const hasInputs = m.querySelectorAll('input:not([type="hidden"]), textarea').length > 0;
      return { title: title.slice(0, 80), hasInputs };
    });

    // ── Toasts / notifications ─────────────────────────────────────────
    const toastSelectors = [
      '[role="alert"]', '[role="status"]', '[aria-live]',
      '[class*="toast" i]', '[class*="notification" i]',
      '[class*="snackbar" i]', '[class*="banner" i]',
      '[class*="alert" i]:not(script)',
    ];
    const toasts: Array<{ type: string; text: string }> = [];
    const seenToasts = new Set<string>();
    for (const sel of toastSelectors) {
      try {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          if (!isVisible(el)) continue;
          const t = getText(el);
          if (t.length < 6 || t.length > 300 || seenToasts.has(t)) continue;
          seenToasts.add(t);
          const cls = ((el.className ?? '') + ' ' + (el.getAttribute('role') ?? '')).toLowerCase();
          let type: string = 'info';
          if (/error|danger|fail|invalid/.test(cls)) type = 'error';
          else if (/success|confirm|done|complete/.test(cls)) type = 'success';
          else if (/warn/.test(cls)) type = 'warning';
          toasts.push({ type, text: t });
        }
      } catch { /* selector error */ }
    }

    // ── Headings ───────────────────────────────────────────────────────
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .filter(isVisible)
      .map((el) => getText(el))
      .filter((t) => t.length > 0)
      .slice(0, 8);

    // ── Loading indicators ─────────────────────────────────────────────
    const loadingVisible = Array.from(document.querySelectorAll(
      '[class*="loading" i], [class*="spinner" i], [class*="skeleton" i], [role="progressbar"]',
    )).some(isVisible);

    // ── Wallet state ───────────────────────────────────────────────────
    const bodyText = (document.body.innerText ?? '').toLowerCase();
    let walletState: string = 'disconnected';
    if (/0x[a-f0-9]{4,}\.{0,3}[a-f0-9]{0,4}/i.test(document.body.innerHTML)) {
      walletState = 'connected';
    } else if (/connecting|連接中/.test(bodyText)) {
      walletState = 'connecting';
    } else if (/connect wallet|連接錢包/.test(bodyText)) {
      walletState = 'disconnected';
    }

    // ── Visible page text (first 1200 chars) ──────────────────────────
    // Gives the LLM context it can't always see in the screenshot:
    // field labels in surrounding divs, instructions, inline errors, etc.
    const visibleText = ((document.body as HTMLElement).innerText ?? '')
      .replace(/\s{3,}/g, '\n')
      .trim()
      .slice(0, 1200);

    return {
      forms,
      buttons,
      modals,
      toasts: toasts.slice(0, 6) as Array<{ type: 'error' | 'success' | 'warning' | 'info'; text: string }>,
      headings,
      visibleText,
      loadingVisible,
      walletState: walletState as 'connected' | 'disconnected' | 'connecting',
    };
  }).catch(() => ({
    forms: [] as FormInfo[],
    buttons: [] as ButtonInfo[],
    modals: [] as ModalInfo[],
    toasts: [] as ToastInfo[],
    headings: [] as string[],
    visibleText: '',
    loadingVisible: false,
    walletState: 'disconnected' as const,
  }));

  return { url, ...extracted };
}

/**
 * Compact string representation for LLM context.
 * Designed to be information-dense: a human reading this would know
 * exactly what the page looks like without seeing a screenshot.
 */
export function formatStateForLLM(state: StructuredPageState): string {
  const lines: string[] = [`URL: ${state.url}`];

  if (state.walletState !== 'disconnected') {
    lines.push(`Wallet: ${state.walletState}`);
  }

  if (state.modals.length > 0) {
    lines.push(`MODAL OPEN: "${state.modals[0].title}"${state.modals[0].hasInputs ? ' (has form inputs)' : ''}`);
  }

  if (state.loadingVisible) {
    lines.push('PAGE IS LOADING (spinner/skeleton visible)');
  }

  if (state.toasts.length > 0) {
    lines.push('Page messages:');
    for (const t of state.toasts) {
      lines.push(`  [${t.type.toUpperCase()}] ${t.text}`);
    }
  }

  if (state.headings.length > 0) {
    lines.push(`Headings: ${state.headings.join(' | ')}`);
  }

  if (state.forms.length > 0) {
    for (const form of state.forms) {
      lines.push('Form fields:');
      for (const f of form.fields) {
        const status = f.filled ? `filled: "${f.value}"` : 'EMPTY';
        lines.push(`  ${f.label} [${f.selector}] (${status})`);
      }
      if (form.submitButton) {
        lines.push(`  Submit button: "${form.submitButton.text}" (${form.submitButton.enabled ? 'ENABLED' : 'disabled'})`);
      }
      if (form.errors.length > 0) {
        lines.push('  ERRORS:');
        for (const e of form.errors) {
          lines.push(`    ⚠ ${e}`);
        }
      }
    }
  }

  if (state.buttons.length > 0) {
    const relevant = state.buttons.filter((b) => b.text.length > 1);
    if (relevant.length > 0) {
      lines.push(`Buttons: ${relevant.map((b) => `"${b.text}"${b.enabled ? '' : ' (disabled)'}`).join(', ')}`);
    }
  }

  if (state.visibleText) {
    lines.push('── Page text (raw) ──');
    lines.push(state.visibleText);
  }

  return lines.join('\n');
}
