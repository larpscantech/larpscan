/**
 * Classifies Solana wallet popup / signing requests for evidence + policy.
 */

export type WalletStack =
  | 'phantom'
  | 'solflare'
  | 'backpack'
  | 'wallet-adapter'
  | 'unknown';

export interface WalletRequestContext {
  type:        'connect' | 'sign_message' | 'sign_transaction' | 'send_transaction' | 'unknown';
  description: string;
  valueSol?:   number;
  programId?:  string;
  severity:    'safe' | 'suspicious' | 'dangerous';
  isExpected:  boolean;
  expectedReason?: string;
  /** @deprecated legacy evidence field */
  popupType?: string;
}

export interface InterceptedWalletPopup {
  popupType?:   string;
  kind?:        string;
  visibleText?: string;
  originUrl?:   string;
  rawData?:     Record<string, unknown>;
  selector?:    string;
  text?:        string;
}

export function classifyWalletRequest(
  popup: InterceptedWalletPopup,
  _claimFeatureType?: string,
  _workflowStage?: string,
): WalletRequestContext {
  const kind = popup.popupType ?? popup.kind ?? 'unknown';

  if (kind === 'connect' || kind === 'connect_prompt') {
    return {
      type: 'connect',
      popupType: kind,
      description: popup.visibleText ?? 'Wallet connect prompt',
      severity: 'safe',
      isExpected: true,
      expectedReason: 'Connecting Phantom investigation wallet on Solana',
    };
  }

  if (kind === 'transaction' || kind === 'tx_prompt' || kind === 'sign_prompt') {
    return {
      type: 'send_transaction',
      popupType: kind,
      description: popup.visibleText ?? 'Transaction / sign prompt',
      severity: 'safe',
      isExpected: true,
      expectedReason: 'Solana program interaction',
    };
  }

  return {
    type: 'unknown',
    popupType: kind,
    description: popup.visibleText ?? 'Unknown wallet prompt',
    severity: 'suspicious',
    isExpected: false,
  };
}
