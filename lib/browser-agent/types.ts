// ─────────────────────────────────────────────────────────────────────────────
// Blocker classification
// ─────────────────────────────────────────────────────────────────────────────

export type BlockerType =
  | 'auth_required'     // login / sign-in wall
  | 'wallet_required'   // connect wallet prompt visible (does NOT auto-stop)
  | 'wallet_only_gate'  // no pre-wallet evidence — confirmed by executor after replanning fails
  | 'feature_disabled'  // UI present but interaction is disabled
  | 'route_missing'     // 404 / page not found
  | 'page_broken'       // blank page, JS crash, white screen
  | 'coming_soon'       // coming soon / under construction
  | 'bot_protection'    // Cloudflare / CAPTCHA
  | 'validation_error'  // form rejected with visible error
  | 'empty_state'       // page loaded but no data (e.g. empty leaderboard)
  | 'rate_limited'      // 429 / rate limit message
  | 'geo_blocked';      // region unavailable

// ─────────────────────────────────────────────────────────────────────────────
// Structured page state — returned by analyzePageState()
// ─────────────────────────────────────────────────────────────────────────────

export interface FormInput {
  name:         string;
  placeholder:  string;
  type:         string;
  label?:       string;  // nearby label text if detectable
}

/**
 * A single interactive element from the browser's accessibility tree.
 * More reliable than DOM text-scraping — includes role, state, and name
 * exactly as screen readers (and GPT-4o vision) would interpret them.
 */
export interface AxInteractiveNode {
  role:        string;    // "button" | "textbox" | "combobox" | "link" | "checkbox" | ...
  name:        string;    // accessible name (label, aria-label, or visible text)
  disabled?:   boolean;
  required?:   boolean;
  value?:      string;    // current input value if any
  expanded?:   boolean;   // for combobox / disclosure
  checked?:    boolean | 'mixed';
}

export interface PageState {
  url:              string;
  title:            string;
  visibleText:      string;                              // up to 2000 chars

  navLinks:         { text: string; href?: string }[];
  links:            { text: string; href?: string }[];  // all a[href] on page
  routeCandidates:  string[];                            // normalized internal hrefs likely to be feature surfaces
  ctaCandidates:    { text: string; selector: string; isPrimary: boolean }[];

  buttons:          { text: string; disabled: boolean; isPrimary: boolean }[];
  forms:            { inputs: FormInput[] }[];
  headings:         string[];
  sectionLabels:    string[];  // section/article/card header text
  tableHeaders:     string[];  // th / columnheader text from visible tables
  chartSignals:     string[];  // label text near canvas / chart elements
  disabledControls: string[];  // text of visibly disabled UI

  blockers:         BlockerType[];
  hasModal:         boolean;
  apiSignals:       string[];  // API calls observed at the time of this snapshot

  /** Interactive elements from the browser accessibility tree.
   *  More reliable than DOM text parsing — includes exact roles, names, and
   *  disabled/required/expanded states as screen readers report them. */
  axInteractive?:   AxInteractiveNode[];

  // Optional enriched ranking metadata (deterministic-first helpers)
  rankedRoutes?:    { path: string; score: number; reason: string }[];
  rankedCtas?:      { text: string; selector: string; score: number; reason: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent step types
// ─────────────────────────────────────────────────────────────────────────────

export type AgentStep =
  | { action: 'navigate';          path: string }
  | { action: 'scroll';            direction: 'down' | 'up'; amount?: number }
  | { action: 'click_text';        text: string }
  | { action: 'click_selector';    selector: string }
  | { action: 'fill_input';        selector: string; value: string }
  | { action: 'wait_for_selector'; selector: string }
  | { action: 'wait_for_text';     text: string }       // wait until text appears in DOM
  | { action: 'open_link_text';    text: string }       // navigate via a[href] matching text
  | { action: 'back' }
  | { action: 'check_text';        text: string };

// ─────────────────────────────────────────────────────────────────────────────
// Workflow stage & outcome classifications
// ─────────────────────────────────────────────────────────────────────────────

export type WorkflowStage =
  | 'recon'
  | 'hypothesis'
  | 'execution'
  | 'recovery'
  | 'summary';

export type StepOutcomeClass =
  | 'progress'
  | 'blocker'
  | 'no_op'
  | 'wrong_surface'
  | 'partial_evidence'
  | 'completion_signal';

export type WorkflowReachState =
  | 'not_reached'
  | 'surface_reached'
  | 'interaction_started'
  | 'evidence_visible'
  | 'gated'
  | 'broken'
  | 'absent';

export interface AttemptMemory {
  attemptedRoutes: string[];
  attemptedCtas: string[];
  attemptedActions: string[];
  noopActions: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Page message — a visible notification/alert/toast extracted after each step.
// Captures what the page explicitly tells the user (success, error, warning…).
// ─────────────────────────────────────────────────────────────────────────────

export interface PageMessage {
  type: 'success' | 'error' | 'warning' | 'info';
  text: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent observation — one per executed step, includes state diff
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentObservation {
  step:             string;
  result:           string;
  isNoop:           boolean;       // true when the action caused no observable change
  stage?:           WorkflowStage;
  outcomeClass?:    StepOutcomeClass;
  url?:             string;        // page URL after action
  urlChanged?:      boolean;
  modalOpened?:     boolean;
  ctaStateChanged?: boolean;
  surfaceMatch?:    'exact' | 'fallback' | 'wrong';
  newInputs?:       string[];      // input names/placeholders that appeared after action
  apiCalls?:        string[];      // network calls triggered within this step's window
  visibleSignals?:  string[];      // new headings/section labels/table headers that appeared
  blockerDetected?: BlockerType;
  pageText?:        string;        // trimmed current page text (up to 400 chars)
  messages?:        PageMessage[]; // visible notification / error / success messages
  narrative?:       string;        // one-sentence human-readable summary of what happened
}
