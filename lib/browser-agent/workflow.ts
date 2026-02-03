import type {
  AgentObservation,
  AgentStep,
  AttemptMemory,
  PageState,
  StepOutcomeClass,
  WorkflowReachState,
} from './types';

export interface WorkflowHypothesis {
  likelySurface?: string;
  firstMeaningfulAction?: AgentStep;
  checkpoints: {
    targetSurfaceReached: boolean;
    moduleVisible: boolean;
    interactionTriggered: boolean;
    strongEvidence: boolean;
  };
  progressCriteria: string[];
  blockerCriteria: string[];
  blockerIndicators: string[];
  strongEvidenceIndicators: string[];
}

export function buildWorkflowHypothesis(
  claim: string,
  featureType: string,
  pageState: PageState,
): WorkflowHypothesis {
  const claimLower = claim.toLowerCase();
  const likelySurface = pageState.routeCandidates.find((r) => claimLower.includes(r.replace('/', '').toLowerCase()))
    ?? pageState.routeCandidates[0];

  const progressCriteria: string[] = [
    'target_surface_reached',
    'module_visible',
    'modal_opened',
    'new_inputs',
    'cta_state_changed',
    'api_activity',
    'new_visible_signals',
    'table_or_card_content_visible',
  ];
  const blockerCriteria: string[] = [...pageState.blockers];
  const blockerIndicators: string[] = [
    'wallet_required without step progression',
    'auth_required unrelated to target module',
    'route_missing or empty_state after navigation',
    'repeated no-op CTA cluster in same module',
  ];
  const strongEvidenceIndicators: string[] = [
    'target route with relevant module visible',
    'form fields appeared and cta became enabled',
    'table/cards rendered with domain data',
    'same-domain API activity after user action',
  ];

  let firstMeaningfulAction: AgentStep | undefined;

  if (likelySurface && likelySurface !== '/') {
    firstMeaningfulAction = { action: 'navigate', path: likelySurface };
  } else if (featureType === 'DATA_DASHBOARD') {
    firstMeaningfulAction = { action: 'scroll', direction: 'down', amount: 900 };
  } else if (pageState.ctaCandidates.length > 0) {
    firstMeaningfulAction = { action: 'click_text', text: pageState.ctaCandidates[0].text };
  }

  return {
    likelySurface,
    firstMeaningfulAction,
    checkpoints: {
      targetSurfaceReached: false,
      moduleVisible: pageState.forms.length > 0 || pageState.tableHeaders.length > 0,
      interactionTriggered: false,
      strongEvidence: false,
    },
    progressCriteria,
    blockerCriteria,
    blockerIndicators,
    strongEvidenceIndicators,
  };
}

export interface OutcomeInput {
  step: AgentStep;
  urlChanged: boolean;
  modalOpened: boolean;
  newInputs: string[];
  apiCalls: string[];
  visibleSignals: string[];
  blockerDetected?: string;
  isNoop: boolean;
  currentUrl: string;
  likelySurface?: string;
  visibleInputCount?: number;
}

export function classifyStepOutcome(input: OutcomeInput): StepOutcomeClass {
  const moduleVisible = input.visibleSignals.length > 0 || (input.visibleInputCount ?? 0) > 0;
  const interactionTriggered = input.modalOpened || input.newInputs.length > 0 || input.apiCalls.length > 0;
  const strongEvidence = moduleVisible && (interactionTriggered || input.apiCalls.length > 0);

  if (input.blockerDetected) {
    // Wallet/auth blockers on a page with visible inputs is still strong evidence
    // of a real workflow, even though completion is gated.
    if (
      (input.blockerDetected === 'wallet_required' || input.blockerDetected === 'auth_required') &&
      moduleVisible
    ) {
      return 'partial_evidence';
    }
    return 'blocker';
  }
  if (input.urlChanged || interactionTriggered || moduleVisible) {
    if (input.likelySurface && input.currentUrl.includes(input.likelySurface) && strongEvidence) return 'completion_signal';
    return 'progress';
  }
  if (input.step.action === 'navigate' && input.likelySurface && !input.currentUrl.includes(input.likelySurface)) {
    return 'wrong_surface';
  }
  if (input.isNoop) return 'no_op';
  return 'partial_evidence';
}

export function isWeakProgress(observations: AgentObservation[]): boolean {
  if (observations.length === 0) return true;
  const noops = observations.filter((o) => o.outcomeClass === 'no_op' || o.isNoop).length;
  const blockers = observations.filter((o) => o.outcomeClass === 'blocker').length;
  const progress = observations.filter((o) => o.outcomeClass === 'progress' || o.outcomeClass === 'completion_signal').length;
  const partialEvidence = observations.filter((o) => o.outcomeClass === 'partial_evidence').length;
  const ctaStateProgress = observations.filter((o) => o.ctaStateChanged).length;
  const walletGatedEvidence = observations.some(
    (o) => o.blockerDetected === 'wallet_required' && (o.newInputs?.length ?? 0) > 0,
  );
  // If wallet gating is encountered but form evidence is visible, this is not
  // weak progress; recovery should avoid random dead-path clicks.
  if (walletGatedEvidence || partialEvidence >= 2 || ctaStateProgress > 0) return false;
  if (blockers > 0 && progress === 0 && partialEvidence === 0) return true;
  return noops / observations.length >= 0.65 && progress <= 1;
}

export function shouldTriggerRecovery(
  observations: AgentObservation[],
  maxSteps: number,
): boolean {
  if (observations.length === 0) return true;
  if (observations.length >= maxSteps) return false;
  return isWeakProgress(observations);
}

export function deriveWorkflowReachState(
  observations: AgentObservation[],
  finalPageState: PageState,
): WorkflowReachState {
  if (finalPageState.blockers.includes('page_broken') || finalPageState.blockers.includes('bot_protection')) return 'broken';
  if (observations.length === 0) return 'not_reached';
  if (finalPageState.blockers.includes('wallet_required') || finalPageState.blockers.includes('auth_required')) return 'gated';
  if (finalPageState.forms.length > 0 || finalPageState.tableHeaders.length > 0 || finalPageState.chartSignals.length > 0) return 'evidence_visible';
  if (observations.some((o) => o.urlChanged || o.modalOpened || (o.newInputs ?? []).length > 0)) return 'interaction_started';
  if (observations.some((o) => (o.outcomeClass === 'wrong_surface'))) return 'absent';
  return 'surface_reached';
}

export function updateAttemptMemory(
  memory: AttemptMemory,
  observations: AgentObservation[],
): AttemptMemory {
  const classifyRoute = (route: string): string => {
    const p = route.toLowerCase();
    if (/leader|rank|stats|dashboard|排行榜|統計|儀表板/.test(p)) return 'dashboard';
    if (/create|launch|mint|token|deploy|創建|生成|啟動/.test(p)) return 'creation';
    if (/swap|claim|bridge|wallet|兌換|領取|橋接|錢包/.test(p)) return 'wallet_flow';
    if (p === '/') return 'home';
    return 'other';
  };
  const classifyCta = (text: string): string => {
    const t = text.toLowerCase();
    if (/leaderboard|rank|stats|排行榜|排名|統計/.test(t)) return 'dashboard';
    if (/create|launch|mint|generate|創建|生成|啟動/.test(t)) return 'creation';
    if (/connect|wallet|claim|swap|bridge|連接|錢包|領取|兌換|橋接/.test(t)) return 'wallet_flow';
    if (/next|continue|submit|confirm|繼續|提交|確認/.test(t)) return 'form_progression';
    return 'other';
  };

  const next = { ...memory };
  for (const obs of observations) {
    next.attemptedActions.push(obs.step);
    if (obs.step.startsWith('navigate("')) {
      const route = obs.step.replace(/^navigate\("/, '').replace(/"\)$/, '');
      next.attemptedRoutes.push(route);
      if (obs.isNoop || obs.outcomeClass === 'no_op') next.noopActions.push(`route_class:${classifyRoute(route)}`);
    }
    if (obs.step.startsWith('open_link_text("') || obs.step.startsWith('click_text("')) {
      const cta = obs.step.replace(/^[a-z_]+\("/, '').replace(/"\)$/, '');
      next.attemptedCtas.push(cta);
      if (obs.isNoop || obs.outcomeClass === 'no_op') next.noopActions.push(`cta_class:${classifyCta(cta)}`);
    }
    if (obs.isNoop || obs.outcomeClass === 'no_op') next.noopActions.push(obs.step);
  }
  next.attemptedActions = [...new Set(next.attemptedActions)];
  next.attemptedRoutes = [...new Set(next.attemptedRoutes)];
  next.attemptedCtas = [...new Set(next.attemptedCtas)];
  next.noopActions = [...new Set(next.noopActions)];
  return next;
}
