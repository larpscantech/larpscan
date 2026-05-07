import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import type { DbAgent } from '@/lib/db-types';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const owner = searchParams.get('owner')?.toLowerCase();
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100);

    let query = supabase
      .from('agents')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (owner) {
      query = query.eq('owner_address', owner);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[agents] fetch error:', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ agents: (data ?? []) as DbAgent[] });
  } catch (err) {
    console.error('[agents] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
