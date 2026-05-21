import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import {
  buildAgentRecordMessage,
  isTimestampFresh,
  verifyWalletMessage,
} from '@/lib/wallet-auth';
import { verifyAgentMintTx } from '@/lib/verify-mint-tx';
import { stripInjectionPhrases } from '@/lib/prompt-safety';

interface RecordAgentBody {
  ownerAddress:  string;
  txHash:        string;
  tokenId?:      string;
  name:          string;
  description?:  string;
  image?:        string;
  personality:   'larpscan' | 'custom';
  systemPrompt?: string;
  signature:     string;
  timestamp:     number;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as RecordAgentBody;

    const {
      ownerAddress,
      txHash,
      tokenId,
      name,
      description,
      image,
      personality,
      systemPrompt,
      signature,
      timestamp,
    } = body;

    if (!ownerAddress || !txHash || !name || !personality || !signature || !timestamp) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!isTimestampFresh(timestamp)) {
      return NextResponse.json({ error: 'Signature expired' }, { status: 401 });
    }

    const message = buildAgentRecordMessage(txHash, timestamp);
    const validSig = await verifyWalletMessage(ownerAddress, signature, message);
    if (!validSig) {
      return NextResponse.json({ error: 'Invalid wallet signature' }, { status: 401 });
    }

    const mintCheck = await verifyAgentMintTx(txHash, ownerAddress);
    if (!mintCheck.ok) {
      return NextResponse.json({ error: mintCheck.error ?? 'Mint not verified' }, { status: 400 });
    }

    const resolvedTokenId = mintCheck.tokenId ?? tokenId ?? null;

    // Prevent duplicate registration for the same on-chain mint
    const { data: existing } = await supabase
      .from('agents')
      .select('id')
      .eq('tx_hash', txHash.toLowerCase())
      .maybeSingle();

    if (existing) {
      return NextResponse.json({ id: existing.id });
    }

    const safePrompt =
      personality === 'custom' && systemPrompt?.trim()
        ? stripInjectionPhrases(systemPrompt.trim()).slice(0, 4_000)
        : null;

    const { data, error } = await supabase
      .from('agents')
      .insert({
        owner_address: ownerAddress.toLowerCase(),
        tx_hash:       txHash.toLowerCase(),
        token_id:      resolvedTokenId,
        name:          name.slice(0, 120),
        description:   description?.slice(0, 500) ?? null,
        image:         image ?? null,
        personality,
        system_prompt: safePrompt,
        chain:         'bsc',
      })
      .select('id')
      .single();

    if (error) {
      console.error('[agent/record] insert error:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ id: data.id });
  } catch (err) {
    console.error('[agent/record] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
