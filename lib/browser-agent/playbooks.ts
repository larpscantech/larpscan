import type { PageState } from './types';

export interface RankedRoute {
  path: string;
  score: number;
  reason: string;
}

export interface RankedCta {
  text: string;
  selector: string;
  score: number;
  reason: string;
}

export interface FeaturePlaybook {
  featureType: string;
  routeKeywords: string[];
  ctaKeywords: string[];
  evidenceSignals: string[];
}

export interface RankingMemory {
  attemptedRoutes?: string[];
  attemptedCtas?: string[];
  noopActions?: string[];
}

function getPlaybookByFeature(featureType: string): FeaturePlaybook {
  switch (featureType) {
    case 'TOKEN_CREATION':
      return {
        featureType,
        routeKeywords: ['create', 'launch', 'mint', 'token', 'deploy', '創建', '啟動', '生成'],
        ctaKeywords: ['create', 'launch', 'generate', 'submit', '開始', '提交', '生成'],
        evidenceSignals: ['form', 'inputs', 'token name', 'token symbol'],
      };
    case 'DATA_DASHBOARD':
      return {
        featureType,
        routeKeywords: ['leaderboard', 'dashboard', 'stats', 'ranking', '排行榜', '統計', '儀表板'],
        ctaKeywords: ['leaderboard', 'stats', 'ranking', '排行榜', '統計'],
        evidenceSignals: ['table', 'chart', 'headers', 'rows'],
      };
    case 'WALLET_FLOW':
      return {
        featureType,
        routeKeywords: ['swap', 'bridge', 'claim', 'wallet', 'mine', 'mining', 'hash', 'worker', '兌換', '橋接', '領取', '錢包', '挖礦', '雜湊', '算力'],
        ctaKeywords: ['connect', 'claim', 'swap', 'bridge', 'mine', 'start', 'generate', '連接', '領取', '兌換', '挖礦', '開始', '生成'],
        evidenceSignals: ['wallet', 'modal', 'form', 'pre-wallet ui', 'hash', 'worker'],
      };
    case 'DEX_SWAP':
    case 'ui+rpc':
      return {
        featureType,
        routeKeywords: ['token', 'trade', 'swap', 'buy', 'sell', 'dex', 'exchange', 'pair', 'market', '交易', '購買', '出售'],
        ctaKeywords: ['buy', 'sell', 'swap', 'trade', 'purchase', '購買', '出售', '兌換', '交易'],
        evidenceSignals: ['amount input', 'token selector', 'buy button', 'sell button', 'tx hash', 'wallet connected'],
      };
    case 'AGENT_LIFECYCLE':
    case 'MULTI_AGENT':
      return {
        featureType,
        routeKeywords: ['agent', 'agents', 'dashboard', 'activity', 'lifecycle', 'logs', 'monitor', 'autonomous', 'deploy'],
        ctaKeywords: ['deploy', 'create agent', 'launch', 'monitor', 'view agents', 'my agents'],
        evidenceSignals: ['agent list', 'lifecycle log', 'activity feed', 'agent status', 'agent id', 'balance'],
      };
    default:
      return {
        featureType,
        routeKeywords: ['feature', 'app', 'use', 'start', 'mine', 'hash', 'worker', '功能', '開始', '挖礦', '雜湊'],
        ctaKeywords: ['start', 'open', 'try', 'begin', 'mine', 'generate', '開始', '進入', '挖礦', '生成'],
        evidenceSignals: ['ui', 'state change', 'modal', 'inputs'],
      };
  }
}

function scoreByKeywords(input: string, keywords: string[]): number {
  const txt = input.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (txt.includes(kw.toLowerCase())) score += 1;
  }
  return score;
}

function isLowValueRoute(path: string): boolean {
  return /(privacy|terms|docs|blog|faq|help|about|contact|policy|legal|careers|twitter|discord|telegram)/i.test(path);
}

function isLowValueCta(text: string): boolean {
  return /(learn more|read more|docs|documentation|more|about|follow|twitter|discord|telegram|help|faq|條款|隱私|說明|更多)/i.test(text);
}

function isDangerousWalletAction(text: string): boolean {
  return /(connect wallet|sign|approve|confirm transaction|buy|sell|pay|連接錢包|簽名|簽署|批准|確認交易|購買|出售|支付)/i.test(text);
}

function routeClass(path: string): string {
  const p = path.toLowerCase();
  if (/leader|rank|stats|dashboard|排行榜|統計|儀表板/.test(p)) return 'dashboard';
  if (/create|launch|mint|token|deploy|創建|生成|啟動/.test(p)) return 'creation';
  if (/swap|bridge|claim|兌換|橋接|領取/.test(p)) return 'wallet_flow';
  if (p === '/') return 'home';
  return 'other';
}

function ctaClass(text: string): string {
  const t = text.toLowerCase();
  if (/leaderboard|rank|stats|排行榜|排名|統計/.test(t)) return 'dashboard';
  if (/create|launch|mint|generate|創建|生成|啟動/.test(t)) return 'creation';
  if (/mine|mining|hash|worker|挖礦|鎖探|雜湊|算力/.test(t)) return 'mining';
  if (/connect|wallet|claim|swap|bridge|連接|錢包|領取|兌換|橋接/.test(t)) return 'wallet_flow';
  if (/next|continue|submit|確認|繼續|提交|送出/.test(t)) return 'form_progression';
  return 'other';
}

function countNoopClass(memory: RankingMemory | undefined, cls: string): number {
  const arr = memory?.noopActions ?? [];
  return arr.filter((s) => {
    const sig = s.toLowerCase();
    if (sig === `route_class:${cls}` || sig === `cta_class:${cls}`) return true;
    if (sig.startsWith('navigate("')) return routeClass(sig) === cls;
    if (sig.startsWith('open_link_text("') || sig.startsWith('click_text("')) return ctaClass(sig) === cls;
    return false;
  }).length;
}

export function getFeaturePlaybook(featureType: string): FeaturePlaybook {
  return getPlaybookByFeature(featureType);
}

export function rankRouteCandidates(
  pageState: PageState,
  featureType: string,
  claim: string,
  memory?: RankingMemory,
  preferredSurface?: string,
): RankedRoute[] {
  const playbook = getPlaybookByFeature(featureType);
  const claimLower = claim.toLowerCase();

  return pageState.routeCandidates
    .map((path) => {
      const navLabel = pageState.navLinks.find((n) => n.href === path)?.text ?? '';
      let score = 0;
      const reasons: string[] = [];

      score += scoreByKeywords(path, playbook.routeKeywords) * 4;
      if (scoreByKeywords(path, playbook.routeKeywords) > 0) reasons.push('route keyword');

      score += scoreByKeywords(navLabel, playbook.routeKeywords) * 3;
      if (scoreByKeywords(navLabel, playbook.routeKeywords) > 0) reasons.push('nav label keyword');

      if (claimLower.includes(path.replace('/', '').toLowerCase())) {
        score += 2;
        reasons.push('claim-route overlap');
      }

      if (path === '/' && featureType !== 'UI_FEATURE' && preferredSurface !== '/') score -= 2;
      if (featureType === 'DATA_DASHBOARD' && (path.includes('leaderboard') || path.includes('dashboard'))) {
        score += 3;
        reasons.push('dashboard feature route');
      }
      if (featureType === 'TOKEN_CREATION' && (path.includes('create') || path.includes('launch'))) {
        score += 3;
        reasons.push('creation feature route');
      }
      if (featureType === 'DEX_SWAP' && /\/token\/|\/trade\/|\/swap\/|\/pair\/|\/market\//i.test(path)) {
        score += 5;
        reasons.push('dex token detail route');
      }
      if (
        featureType !== 'DATA_DASHBOARD' &&
        /(leaderboard|dashboard|rank|stats|排行榜|儀表板|統計)/i.test(path) &&
        !/(leaderboard|dashboard|rank|stats|排行榜|儀表板|統計)/i.test(claimLower)
      ) {
        score -= 4;
        reasons.push('off-workflow dashboard route');
      }
      if (preferredSurface) {
        if (path === preferredSurface) {
          score += 5;
          reasons.push('configured surface');
        } else if (preferredSurface === '/' && path !== '/' && featureType !== 'DATA_DASHBOARD') {
          score -= 2;
          reasons.push('away from configured root surface');
        }
      }
      if (isLowValueRoute(path)) {
        score -= 4;
        reasons.push('low-value route');
      }
      if (pageState.url.includes(path) && path !== '/') {
        score -= 1;
        reasons.push('already on route');
      }
      if ((memory?.attemptedRoutes ?? []).includes(path)) {
        score -= 3;
        reasons.push('already attempted route');
      }
      const cls = routeClass(path);
      const clsNoops = countNoopClass(memory, cls);
      if (clsNoops >= 2) {
        score -= 4;
        reasons.push(`dead route class (${cls})`);
      }
      if (pageState.rankedRoutes?.some((r) => r.path === path && r.score >= 6)) {
        score += 2;
        reasons.push('analysis-ranked high');
      }

      return { path, score, reason: reasons.join(', ') || 'baseline route candidate' };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

export function rankCtaCandidates(
  pageState: PageState,
  featureType: string,
  claim: string,
  memory?: RankingMemory,
): RankedCta[] {
  const playbook = getPlaybookByFeature(featureType);
  const claimLower = claim.toLowerCase();

  return pageState.ctaCandidates
    .map((cta) => {
      let score = 0;
      const reasons: string[] = [];

      score += scoreByKeywords(cta.text, playbook.ctaKeywords) * 4;
      if (scoreByKeywords(cta.text, playbook.ctaKeywords) > 0) reasons.push('cta keyword');

      if (cta.isPrimary) {
        score += 2;
        reasons.push('primary cta');
      }

      if (claimLower.includes(cta.text.toLowerCase())) {
        score += 1;
        reasons.push('claim-cta overlap');
      }

      if (pageState.disabledControls.some((d) => d.toLowerCase().includes(cta.text.toLowerCase()))) {
        score -= 3;
        reasons.push('disabled control');
      }
      if (isLowValueCta(cta.text)) {
        score -= 3;
        reasons.push('decorative/low-value cta');
      }
      if (isDangerousWalletAction(cta.text)) {
        score -= 2;
        reasons.push('wallet action (safety-limited)');
      }
      if ((memory?.attemptedCtas ?? []).includes(cta.text)) {
        score -= 3;
        reasons.push('already attempted cta');
      }
      const cls = ctaClass(cta.text);
      const clsNoops = countNoopClass(memory, cls);
      if (clsNoops >= 2) {
        score -= 4;
        reasons.push(`dead cta class (${cls})`);
      }
      if (pageState.navLinks.some((n) => (n.text ?? '').trim() === cta.text.trim())) {
        score -= 1;
        reasons.push('global nav duplicate');
      }
      if (pageState.forms.length > 0 && /(submit|continue|next|create|launch|確認|繼續|提交|送出|生成|創建|啟動)/i.test(cta.text)) {
        score += 2;
        reasons.push('adjacent to form progression');
      }
      if (featureType === 'DATA_DASHBOARD' && /(leaderboard|rank|stats|排行榜|排名|統計)/i.test(cta.text)) {
        score += 2;
        reasons.push('dashboard-specific cta');
      }
      if (featureType === 'TOKEN_CREATION' && /(create|launch|mint|生成|創建|啟動)/i.test(cta.text)) {
        score += 2;
        reasons.push('creation-specific cta');
      }

      return { text: cta.text, selector: cta.selector, score, reason: reasons.join(', ') || 'baseline cta candidate' };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}
