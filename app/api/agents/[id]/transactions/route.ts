import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import type { AgentTxType } from '@/lib/db-types';

// ── GET /api/agents/[id]/transactions ─────────────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const { data, error } = await supabase
      .from('agent_transactions')
      .select('*')
      .eq('agent_id', id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ transactions: data ?? [] });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── POST /api/agents/[id]/transactions ────────────────────────────────────────
interface TxBody {
  txHash:     string;
  txType:     AgentTxType;
  amountBnb?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as TxBody;
    const { txHash, txType, amountBnb } = body;

    if (!txHash || !txType) {
      return NextResponse.json({ error: 'txHash and txType required' }, { status: 400 });
    }

    const { error } = await supabase.from('agent_transactions').insert({
      agent_id:   id,
      tx_hash:    txHash,
      tx_type:    txType,
      amount_bnb: amountBnb ?? null,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
