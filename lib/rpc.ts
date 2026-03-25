import { createPublicClient, http, isAddress, parseAbi } from 'viem';
import { bsc } from 'viem/chains';
import type { Address } from 'viem';

// Fall back to the public BSC dataseed if NODEREAL_RPC is not configured
const rpcUrl = process.env.NODEREAL_RPC ?? 'https://bsc-dataseed.binance.org/';

export const rpcClient = createPublicClient({
  chain: bsc,
  transport: http(rpcUrl),
});

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
]);

/**
 * Ensures an address is a deployed smart contract (has bytecode).
 * Throws if the address is an EOA or the format is invalid.
 */
export async function validateContract(address: string): Promise<void> {
  if (!isAddress(address)) {
    throw new Error('Invalid address format — must be a checksummed or lowercase hex address');
  }

  const code = await rpcClient.getBytecode({ address: address as Address });

  if (!code || code === '0x') {
    throw new Error('Address has no bytecode — not a deployed smart contract');
  }
}

/**
 * Reads name() and symbol() from an ERC-20 contract.
 * Falls back gracefully if the contract does not implement these.
 */
export async function getTokenMetadata(
  address: string,
): Promise<{ name: string; symbol: string }> {
  const addr = address as Address;

  const [name, symbol] = await Promise.all([
    rpcClient
      .readContract({ address: addr, abi: ERC20_ABI, functionName: 'name' })
      .catch(() => 'Unknown Token'),
    rpcClient
      .readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' })
      .catch(() => 'UNKNOWN'),
  ]);

  return { name: name as string, symbol: symbol as string };
}
