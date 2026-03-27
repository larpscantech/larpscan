import { createPublicClient, http, isAddress, parseAbi, formatEther, formatUnits } from 'viem';
import { bsc } from 'viem/chains';
import type { Address } from 'viem';

const rpcUrl = process.env.NODEREAL_RPC ?? 'https://bsc-dataseed.binance.org/';

export const rpcClient = createPublicClient({
  chain: bsc,
  transport: http(rpcUrl, { timeout: 15_000 }),
});

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function owner() view returns (address)',
]);

const PAIR_ABI = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
]);

const FACTORY_ABI = parseAbi([
  'function getPair(address, address) view returns (address)',
]);

const PANCAKE_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' as Address;
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c' as Address;
const USDT = '0x55d398326f99059fF775485246999027B3197955' as Address;
const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56' as Address;

export async function validateContract(address: string): Promise<void> {
  if (!isAddress(address)) {
    throw new Error('Invalid address format — must be a checksummed or lowercase hex address');
  }
  const code = await rpcClient.getBytecode({ address: address as Address });
  if (!code || code === '0x') {
    throw new Error('Address has no bytecode — not a deployed smart contract');
  }
}

export async function getTokenMetadata(
  address: string,
): Promise<{ name: string; symbol: string }> {
  const addr = address as Address;
  const [name, symbol] = await Promise.all([
    rpcClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'name' }).catch(() => 'Unknown Token'),
    rpcClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'UNKNOWN'),
  ]);
  return { name: name as string, symbol: symbol as string };
}

// ── Deep on-chain contract analysis (no BscScan API needed) ─────────────────

export interface OnChainReport {
  address:         string;
  isContract:      boolean;
  bytecodeSize:    number;
  name:            string | null;
  symbol:          string | null;
  decimals:        number | null;
  totalSupply:     string | null;
  owner:           string | null;
  bnbBalance:      string;
  hasLiquidity:    boolean;
  liquidityPairs:  LiquidityPair[];
  isProxy:         boolean;
  proxyImpl:       string | null;
  creationTxCount: number | null;
  signals:         string[];
}

interface LiquidityPair {
  pairAddress: string;
  quoteToken:  string;
  quoteSymbol: string;
  reserve0:    string;
  reserve1:    string;
}

export async function analyzeContractOnChain(address: string): Promise<OnChainReport> {
  const addr = address as Address;
  const signals: string[] = [];

  // 1. Bytecode check
  const code = await rpcClient.getBytecode({ address: addr }).catch(() => null);
  const isContract = !!code && code !== '0x';
  const bytecodeSize = code ? Math.floor((code.length - 2) / 2) : 0;

  if (!isContract) {
    return {
      address, isContract: false, bytecodeSize: 0,
      name: null, symbol: null, decimals: null, totalSupply: null, owner: null,
      bnbBalance: '0', hasLiquidity: false, liquidityPairs: [], isProxy: false,
      proxyImpl: null, creationTxCount: null,
      signals: ['NOT_A_CONTRACT: address has no bytecode on BSC'],
    };
  }
  signals.push(`CONTRACT_LIVE: ${bytecodeSize} bytes of bytecode deployed`);

  // 2. ERC-20 metadata
  const [name, symbol, decimals, totalSupply, owner] = await Promise.all([
    rpcClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'name' }).catch(() => null),
    rpcClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null),
    rpcClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => null),
    rpcClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => null),
    rpcClient.readContract({ address: addr, abi: ERC20_ABI, functionName: 'owner' }).catch(() => null),
  ]);

  const nameStr = name as string | null;
  const symbolStr = symbol as string | null;
  const dec = decimals as number | null;
  const supply = totalSupply as bigint | null;
  const ownerAddr = owner as string | null;

  if (nameStr) signals.push(`TOKEN_NAME: ${nameStr}`);
  if (symbolStr) signals.push(`TOKEN_SYMBOL: ${symbolStr}`);
  if (supply !== null && dec !== null) {
    signals.push(`TOTAL_SUPPLY: ${formatUnits(supply, dec)} ${symbolStr ?? ''}`);
  }
  if (ownerAddr && ownerAddr !== '0x0000000000000000000000000000000000000000') {
    signals.push(`OWNER: ${ownerAddr}`);
  } else if (ownerAddr === '0x0000000000000000000000000000000000000000') {
    signals.push('OWNERSHIP_RENOUNCED: owner is zero address');
  }

  // 3. BNB balance
  const balance = await rpcClient.getBalance({ address: addr }).catch(() => BigInt(0));
  const bnbBalance = formatEther(balance);
  if (balance > BigInt(0)) signals.push(`BNB_BALANCE: ${bnbBalance} BNB`);

  // 4. Proxy detection (EIP-1967 storage slot)
  const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  let isProxy = false;
  let proxyImpl: string | null = null;
  try {
    const implSlot = await rpcClient.getStorageAt({ address: addr, slot: EIP1967_IMPL_SLOT as `0x${string}` });
    if (implSlot && implSlot !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
      isProxy = true;
      proxyImpl = '0x' + implSlot.slice(26);
      signals.push(`PROXY_CONTRACT: implementation at ${proxyImpl}`);
    }
  } catch { /* not a proxy */ }

  // 5. PancakeSwap liquidity check (WBNB, USDT, BUSD pairs)
  const liquidityPairs: LiquidityPair[] = [];
  const quoteTokens = [
    { addr: WBNB, symbol: 'WBNB' },
    { addr: USDT, symbol: 'USDT' },
    { addr: BUSD, symbol: 'BUSD' },
  ];

  for (const qt of quoteTokens) {
    try {
      const pairAddr = await rpcClient.readContract({
        address: PANCAKE_FACTORY,
        abi: FACTORY_ABI,
        functionName: 'getPair',
        args: [addr, qt.addr],
      }) as Address;

      if (pairAddr && pairAddr !== '0x0000000000000000000000000000000000000000') {
        const [r0, r1] = await rpcClient.readContract({
          address: pairAddr,
          abi: PAIR_ABI,
          functionName: 'getReserves',
        }) as [bigint, bigint, number];

        if (r0 > BigInt(0) || r1 > BigInt(0)) {
          liquidityPairs.push({
            pairAddress: pairAddr,
            quoteToken: qt.addr,
            quoteSymbol: qt.symbol,
            reserve0: r0.toString(),
            reserve1: r1.toString(),
          });
          signals.push(`LIQUIDITY_${qt.symbol}: pair ${pairAddr.slice(0, 10)}… reserves ${r0 > BigInt(0) ? 'active' : 'empty'}`);
        }
      }
    } catch { /* pair doesn't exist or factory call failed */ }
  }

  const hasLiquidity = liquidityPairs.length > 0;
  if (!hasLiquidity) signals.push('NO_PANCAKESWAP_LIQUIDITY: no WBNB/USDT/BUSD pair found');

  // 6. Transaction count (proxy for activity)
  let creationTxCount: number | null = null;
  try {
    const txCount = await rpcClient.getTransactionCount({ address: addr });
    creationTxCount = txCount;
    if (txCount > 0) signals.push(`TX_COUNT: ${txCount} outgoing transactions`);
  } catch { /* non-fatal */ }

  return {
    address,
    isContract,
    bytecodeSize,
    name: nameStr,
    symbol: symbolStr,
    decimals: dec,
    totalSupply: supply !== null && dec !== null ? formatUnits(supply, dec) : null,
    owner: ownerAddr,
    bnbBalance,
    hasLiquidity,
    liquidityPairs,
    isProxy,
    proxyImpl,
    creationTxCount,
    signals,
  };
}

/** Formats an OnChainReport into human-readable evidence lines. */
export function formatOnChainEvidence(report: OnChainReport): string {
  const lines = [
    `On-chain analysis for ${report.address} (BSC):`,
    ...report.signals.map((s) => `  • ${s}`),
  ];
  return lines.join('\n');
}
