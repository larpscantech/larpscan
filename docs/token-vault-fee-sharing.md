# Why `didntwork.json` vs `workedd.json` differ

Reference payloads (BNBshare / Flap-style token creation API params).

## What failed (`didntwork.json`)

- **`vaultFactory`**: `0x4B89d46b1829fd44cF8f5Ff62e3B3e0750026F99`
- **`vaultData`**: Long ABI-encoded blob with a **Twitter / social fee-recipient** path (`testuser`, `twitter`, embedded address `0x3fa6…`, signature bytes).
- The UI had **fee sharing to X/Twitter** enabled with a **fake `@testuser`**. That builds a **signed social vault** the chain rejects → **revert** (or internal revert while outer tx still “succeeds” on BscScan).

## What worked (`workedd.json`)

- **`vaultFactory`**: `0xfab75Dc774cB9B38b91749B8833360B46a52345F`
- **`vaultData`**: Short encoding with the **connected investigation wallet** `0x1B63…96B1` + numeric args (e.g. `0x2710` = 10000 bps) — the **simple vault** path.

## ChainVerify fix

- Fake handles like `@testuser` in **fee-sharing / X username** fields can still produce **invalid signed vault payloads** → revert.
- The agent fills those inputs via `__CV_FEE_SHARE_SOCIAL_HANDLE__` → hardcoded value `FEE_SHARE_X_HANDLE_VALUE` in `lib/browser-agent/constants.ts` (default `ethereum`). Change there if a site requires a different real handle.
- `__CV_INVESTIGATION_WALLET__` is only for fields that explicitly expect a **0x** fee recipient, not `@username` social fields.
