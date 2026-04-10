/**
 * Runtime substitution in executor.fill_input when the planner emits this token.
 */
export const INVESTIGATION_WALLET_FILL_TOKEN = '__CV_INVESTIGATION_WALLET__';

/**
 * Planner may emit this in fill_input; executor replaces it with {@link SOCIAL_HANDLE_VALUE}.
 * Used for any social handle / username field (Ensoul, BNBShare fee-sharing, etc.).
 * The vault signer patches any SignedSocialVaultFactory calls to use SimpleVaultFactory,
 * so the handle itself does not need to be a real registered account.
 */
export const SOCIAL_HANDLE_FILL_TOKEN = '__CV_SOCIAL_HANDLE__';

/** Hardcoded username (no @) for social handle fields during verification. */
export const SOCIAL_HANDLE_VALUE = 'testuser';

/** @deprecated Use SOCIAL_HANDLE_FILL_TOKEN instead. */
export const FEE_SHARE_SOCIAL_HANDLE_FILL_TOKEN = SOCIAL_HANDLE_FILL_TOKEN;
/** @deprecated Use SOCIAL_HANDLE_VALUE instead. */
export const FEE_SHARE_X_HANDLE_VALUE = SOCIAL_HANDLE_VALUE;

/** Ordered fallback handles when the primary handle is already taken.
 *  Uses varied prefixes so that even if testuser* are all minted from prior
 *  test runs, the agent still finds an available handle. */
export const HANDLE_FALLBACK_SEQUENCE = [
  'testuser',
  'larpscanbnb',
  'testuser2',
  'testuser3',
  'testuser4',
  'lscantest01',
  'lscantest02',
  'lscantest03',
  'lscantest04',
  'lscantest05',
  'verifybot01',
  'verifybot02',
  'verifybot03',
  'agenttest01',
  'agenttest02',
  'agenttest03',
  'scantest_x1',
  'scantest_x2',
  'scantest_x3',
  'scantest_x4',
];
