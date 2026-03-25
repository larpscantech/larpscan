import { recoverAddress, keccak256, encodePacked, encodeAbiParameters, parseAbiParameters, toHex } from 'viem';
import { createPublicClient, http } from 'viem';
import { bsc } from 'viem/chains';

async function main() {
  const client = createPublicClient({ chain: bsc, transport: http('https://bsc-mainnet.nodereal.io/v1/6d10ed3cc43a47dd845f681d657cfdea') });

  // From our failed transaction vaultData (checksum: 0x02Dd0fEb0b2D9db371496726C196815435cD8C3B)
  const recipient = '0x02Dd0fEb0b2D9db371496726C196815435cD8C3B' as `0x${string}`;
  const handle = 'ethereum';
  const platform = 'twitter';
  const expiry = BigInt('0x69bf5676'); // 1774150262
  const sig = '0x5ba071f25d4a58ea863907479d1cab851a20b5c7940b222580ab60422fea63c20ed9845959a78315463c77bf74c503d339fb418255f10acf2bcc0f8376bc03491b' as `0x${string}`;

  // Try multiple hash formats to figure out what the contract expects
  const hash_abi_encode = keccak256(encodeAbiParameters(
    parseAbiParameters('address, string, string, uint256'),
    [recipient, handle, platform, expiry]
  ));
  const hash_packed = keccak256(encodePacked(
    ['address', 'string', 'string', 'uint256'],
    [recipient, handle, platform, expiry]
  ));
  // Also try with eth_sign prefix
  const prefix = '\x19Ethereum Signed Message:\n32';
  const hash_prefixed_abi = keccak256(encodePacked(['string', 'bytes32'], [prefix, hash_abi_encode]));
  const hash_prefixed_packed = keccak256(encodePacked(['string', 'bytes32'], [prefix, hash_packed]));

  const variants = [
    ['abi.encode(recipient,handle,platform,expiry)', hash_abi_encode],
    ['encodePacked(recipient,handle,platform,expiry)', hash_packed],
    ['eth_sign prefix + abi.encode hash', hash_prefixed_abi],
    ['eth_sign prefix + packed hash', hash_prefixed_packed],
  ] as [string, `0x${string}`][];

  console.log('Attempting signer recovery...\n');
  for (const [label, hash] of variants) {
    try {
      const signer = await recoverAddress({ hash, signature: sig });
      console.log(`✓ [${label}]\n  Signer: ${signer}\n`);
    } catch (e) { console.log(`✗ [${label}]: ${e instanceof Error ? e.message.slice(0,60) : e}\n`); }
  }

  // Read vault factory storage to find trustedSigner
  const vaultFactory = '0x3fca49851d6e6082630729f9dc4334a4eefe795d' as `0x${string}`;
  console.log('\nVault factory storage slots:');
  for (let slot = 0; slot < 8; slot++) {
    const val = await client.getStorageAt({ address: vaultFactory, slot: toHex(slot, { size: 32 }) });
    const isZero = val === '0x0000000000000000000000000000000000000000000000000000000000000000';
    console.log(`  slot[${slot}] = ${val}${isZero ? ' (zero)' : ' ← NONZERO'}`);
  }
}
main().catch(console.error);
