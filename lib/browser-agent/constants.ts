/**
 * Runtime substitution in executor.fill_input when the planner emits this token.
 */
export const INVESTIGATION_WALLET_FILL_TOKEN = '__CV_INVESTIGATION_WALLET__';

/**
 * Planner may emit this in fill_input; executor replaces it with {@link FEE_SHARE_X_HANDLE_VALUE}.
 * The vault signer patches any SignedSocialVaultFactory calls to use SimpleVaultFactory,
 * so the handle itself does not need to be a real registered Twitter account.
 */
export const FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN = '__CV_FEE_SHARE_SOCIAL_HANDLE__';

/** Hardcoded X username (no @) for fee-sharing fields during verification. */
export const FEE_SHARE_X_HANDLE_VALUE = 'testuser';
