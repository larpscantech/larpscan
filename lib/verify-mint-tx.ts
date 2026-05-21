import { createPublicClient, http, decodeEventLog } from 'viem';
import { bsc } from 'viem/chains';
import { NFA_CONTRACT_ADDRESS } from '@/lib/nfa-contract';

const ERC721_TRANSFER = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { indexed: true,  name: 'from',  type: 'address' },
    { indexed: true,  name: 'to',    type: 'address' },
    { indexed: true,  name: 'tokenId', type: 'uint256' },
  ],
} as const;

function getPublicClient() {
  const rpc = process.env.NODEREAL_RPC ?? 'https://bsc-dataseed.binance.org/';
  return createPublicClient({ chain: bsc, transport: http(rpc) });
}

export interface MintTxVerification {
  ok: boolean;
  tokenId?: string;
  error?: string;
}

/**
 * Confirms txHash is a successful mint on the NFA contract to ownerAddress.
 */
export async function verifyAgentMintTx(
  txHash: string,
  ownerAddress: string,
): Promise<MintTxVerification> {
  const hash = txHash.trim() as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return { ok: false, error: 'Invalid transaction hash' };
  }

  const owner = ownerAddress.toLowerCase() as `0x${string}`;
  const client = getPublicClient();

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch {
    return { ok: false, error: 'Transaction not found on BSC' };
  }

  if (receipt.status !== 'success') {
    return { ok: false, error: 'Transaction reverted' };
  }

  const nfa = NFA_CONTRACT_ADDRESS.toLowerCase();
  let tokenId: string | undefined;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== nfa) continue;
    try {
      const decoded = decodeEventLog({
        abi: [ERC721_TRANSFER],
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== 'Transfer') continue;
      const to = (decoded.args as { to: string }).to?.toLowerCase();
      const from = (decoded.args as { from: string }).from?.toLowerCase();
      if (to !== owner) continue;
      // Mint: from zero address
      if (from !== '0x0000000000000000000000000000000000000000') continue;
      tokenId = (decoded.args as { tokenId: bigint }).tokenId.toString();
      break;
    } catch {
      continue;
    }
  }

  if (!tokenId) {
    return { ok: false, error: 'No NFA mint Transfer event to this wallet' };
  }

  return { ok: true, tokenId };
}
