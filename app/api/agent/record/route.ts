import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

interface RecordAgentBody {
  ownerAddress:  string;
  txHash:        string;
  tokenId?:      string;
  name:          string;
  description?:  string;
  image?:        string;
  personality:   'larpscan' | 'custom';
  systemPrompt?: string;
}

export async function POST(req: Request) {
  try {
  const body = (await req.json()) as RecordAgentBody;

  const { ownerAddress, txHash, tokenId, name, description, image, personality, systemPrompt } = body;

    if (!ownerAddress || !txHash || !name || !personality) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('agents')
      .insert({
        owner_address: ownerAddress.toLowerCase(),
        tx_hash:       txHash,
        token_id:      tokenId ?? null,
        name,
        description:   description ?? null,
        image:         image ?? null,
        personality,
        system_prompt: personality === 'custom' ? (systemPrompt ?? null) : null,
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
