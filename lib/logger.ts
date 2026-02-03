import { supabase } from './supabase';

/**
 * Inserts a single message into agent_logs for a given verification run.
 * Errors are swallowed so a logging failure never breaks the pipeline.
 */
export async function log(runId: string, message: string): Promise<void> {
  const { error } = await supabase
    .from('agent_logs')
    .insert({ verification_run_id: runId, message });

  if (error) {
    console.error('[logger] Failed to insert log:', error.message);
  }
}

/**
 * Inserts multiple log messages in a single batch insert.
 */
export async function logBatch(runId: string, messages: string[]): Promise<void> {
  if (messages.length === 0) return;

  const rows = messages.map((message) => ({
    verification_run_id: runId,
    message,
  }));

  const { error } = await supabase.from('agent_logs').insert(rows);

  if (error) {
    console.error('[logger] Failed to batch insert logs:', error.message);
  }
}
