import { verifyMessage } from 'viem';

const MESSAGE_TTL_MS = 5 * 60 * 1000;

export function buildAgentEditMessage(agentId: string, timestamp: number): string {
  return `larpscan:edit-agent:${agentId}:${timestamp}`;
}

export function buildAgentRecordMessage(txHash: string, timestamp: number): string {
  return `larpscan:record-agent:${txHash.toLowerCase()}:${timestamp}`;
}

export async function verifyWalletMessage(
  address: string,
  signature: `0x${string}` | string,
  message: string,
): Promise<boolean> {
  try {
    return await verifyMessage({
      address: address.toLowerCase() as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

/** Reject stale or malformed signed-request timestamps. */
export function isTimestampFresh(timestamp: number): boolean {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  const age = Math.abs(Date.now() - timestamp);
  return age <= MESSAGE_TTL_MS;
}
