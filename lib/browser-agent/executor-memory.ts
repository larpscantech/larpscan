// ─────────────────────────────────────────────────────────────────────────────
// StructuredMemory — the agent's working memory across the ReAct loop.
//
// Every field exists because the agent previously failed without it:
//   actionsPerformed  → agent repeated the same action (no memory of what it did)
//   triedValues       → agent tried "testuser1" twice (no memory of tried names)
//   errorsEncountered → agent ignored "already exists" (no memory of errors)
//   formState         → agent re-filled fields it already filled
//   currentPhase      → agent navigated away from a form it was filling
//   isComplete        → agent kept going after success (no stop signal)
// ─────────────────────────────────────────────────────────────────────────────

export type AgentPhase =
  | 'navigation'
  | 'form_filling'
  | 'form_submission'
  | 'confirmation'
  | 'error_recovery';

export interface ActionRecord {
  action: string;
  target?: string;
  value?: string;
  result: 'success' | 'error' | 'noop';
  detail: string;
}

export interface ErrorRecord {
  message: string;
  afterAction: string;
  resolved: boolean;
}

export interface AgentMemory {
  objective: string;
  currentPhase: AgentPhase;
  actionsPerformed: ActionRecord[];
  triedValues: Record<string, string[]>;
  errorsEncountered: ErrorRecord[];
  formState: Record<string, string>;
  transactionsAttempted: string[];
  isComplete: boolean;
  completionReason: string | null;
}

export function createMemory(objective: string): AgentMemory {
  return {
    objective,
    currentPhase: 'navigation',
    actionsPerformed: [],
    triedValues: {},
    errorsEncountered: [],
    formState: {},
    transactionsAttempted: [],
    isComplete: false,
    completionReason: null,
  };
}

export interface StepResult {
  action: string;
  target?: string;
  value?: string;
  success: boolean;
  noop: boolean;
  urlChanged: boolean;
  newUrl?: string;
  pageMessages: Array<{ type: string; text: string }>;
  visibleErrors: string[];
}

/**
 * Update memory after each step. Pure function — returns new memory.
 * The logic here is intentionally simple and deterministic:
 * phase transitions are based on observable facts, not heuristics.
 */
export function updateMemory(prev: AgentMemory, result: StepResult): AgentMemory {
  const mem: AgentMemory = {
    ...prev,
    actionsPerformed: [...prev.actionsPerformed],
    triedValues: { ...prev.triedValues },
    errorsEncountered: [...prev.errorsEncountered],
    formState: { ...prev.formState },
    transactionsAttempted: [...prev.transactionsAttempted],
  };

  // Record the action
  mem.actionsPerformed.push({
    action: result.action,
    target: result.target,
    value: result.value,
    result: result.noop ? 'noop' : result.success ? 'success' : 'error',
    detail: result.pageMessages.map((m) => `[${m.type}] ${m.text}`).join('; ') || (result.noop ? 'no visible change' : 'ok'),
  });

  // Track tried values for fill actions
  if (result.action === 'fill_input' && result.target && result.value) {
    const key = result.target;
    if (!mem.triedValues[key]) mem.triedValues[key] = [];
    if (!mem.triedValues[key].includes(result.value)) {
      mem.triedValues[key].push(result.value);
    }
    mem.formState[key] = result.value;
  }

  // Track errors
  const allErrors = [
    ...result.visibleErrors,
    ...result.pageMessages.filter((m) => m.type === 'error').map((m) => m.text),
  ];
  for (const errMsg of allErrors) {
    const existing = mem.errorsEncountered.find((e) => e.message === errMsg && !e.resolved);
    if (!existing) {
      mem.errorsEncountered.push({
        message: errMsg,
        afterAction: result.action,
        resolved: false,
      });
    }
  }

  // Mark previous errors as resolved if they're no longer visible
  for (const err of mem.errorsEncountered) {
    if (!err.resolved && !allErrors.includes(err.message)) {
      err.resolved = true;
    }
  }

  // Track transaction signals
  const txSignals = result.pageMessages.filter((m) =>
    /transaction|tx\s*(hash|confirmed|submitted|success)|minted|deployed|created successfully/i.test(m.text),
  );
  for (const tx of txSignals) {
    mem.transactionsAttempted.push(tx.text);
  }

  // Phase transitions based on observable facts
  if (result.urlChanged) {
    mem.currentPhase = 'navigation';
  }
  if (result.action === 'fill_input') {
    mem.currentPhase = 'form_filling';
  }
  if (
    (result.action === 'click_text' || result.action === 'click_selector') &&
    mem.currentPhase === 'form_filling'
  ) {
    mem.currentPhase = 'form_submission';
  }
  if (allErrors.length > 0 && mem.currentPhase === 'form_submission') {
    mem.currentPhase = 'error_recovery';
  }
  if (txSignals.length > 0) {
    mem.currentPhase = 'confirmation';
  }

  // Completion detection (conservative — the dedicated checkCompletion will be more thorough)
  const successMessages = result.pageMessages.filter((m) => m.type === 'success');
  if (successMessages.length > 0 && txSignals.length > 0) {
    mem.isComplete = true;
    mem.completionReason = `Transaction confirmed: ${txSignals[0].text}`;
  }

  return mem;
}

/**
 * Compact string for LLM context. Keeps only what matters for the next decision.
 */
export function formatMemoryForLLM(mem: AgentMemory): string {
  const lines: string[] = [
    `Objective: ${mem.objective}`,
    `Phase: ${mem.currentPhase}`,
    `Steps taken: ${mem.actionsPerformed.length}`,
  ];

  // Recent actions (last 5)
  const recent = mem.actionsPerformed.slice(-5);
  if (recent.length > 0) {
    lines.push('Recent actions:');
    for (const a of recent) {
      const val = a.value ? ` "${a.value}"` : '';
      const tgt = a.target ? ` on ${a.target}` : '';
      lines.push(`  ${a.action}${tgt}${val} → ${a.result}${a.detail !== 'ok' && a.detail !== 'no visible change' ? ` (${a.detail})` : ''}`);
    }
  }

  // Tried values
  const triedEntries = Object.entries(mem.triedValues).filter(([, v]) => v.length > 0);
  if (triedEntries.length > 0) {
    lines.push('Values already tried:');
    for (const [field, values] of triedEntries) {
      lines.push(`  ${field}: ${values.map((v) => `"${v}"`).join(', ')}`);
    }
  }

  // Active errors
  const activeErrors = mem.errorsEncountered.filter((e) => !e.resolved);
  if (activeErrors.length > 0) {
    lines.push('ACTIVE ERRORS:');
    for (const e of activeErrors) {
      lines.push(`  ⚠ "${e.message}" (after ${e.afterAction})`);
    }
  }

  // Transactions
  if (mem.transactionsAttempted.length > 0) {
    lines.push(`Transactions: ${mem.transactionsAttempted.join('; ')}`);
  }

  if (mem.isComplete) {
    lines.push(`COMPLETE: ${mem.completionReason}`);
  }

  return lines.join('\n');
}

/**
 * Check if the agent is about to repeat an exact action it already performed.
 * Returns the previous result if found, null otherwise.
 */
export function findDuplicateAction(
  mem: AgentMemory,
  action: string,
  target?: string,
  value?: string,
): ActionRecord | null {
  return mem.actionsPerformed.find((a) =>
    a.action === action &&
    a.target === target &&
    a.value === value,
  ) ?? null;
}
