import OpenAI from 'openai';
import path from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface NarrationSegment {
  text:        string;
  timestampMs: number;
}

type TtsVoice = 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable' | 'nova' | 'onyx' | 'sage' | 'shimmer';

const DEFAULT_VOICE: TtsVoice = 'onyx';

let _ttsClient: OpenAI | null = null;
function getTtsClient(): OpenAI {
  if (_ttsClient) return _ttsClient;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  _ttsClient = new OpenAI({ apiKey: key });
  return _ttsClient;
}

/**
 * Generate a single narration audio track from thinking segments,
 * timed to match video timestamps using silence padding.
 *
 * All intermediate clips are WAV (pcm_s16le, 24kHz, mono) to avoid
 * format mismatches in the ffmpeg concat demuxer. The final output
 * is encoded to MP3.
 *
 * Returns an MP3 buffer or null if narration is disabled / fails.
 */
export async function generateNarration(
  segments: NarrationSegment[],
  videoDurationMs: number,
): Promise<Buffer | null> {
  if (process.env.ENABLE_VOICE_NARRATION !== 'true') return null;
  if (segments.length === 0) return null;

  let ffmpegPath: string;
  try {
    ffmpegPath = require('ffmpeg-static') as string;
  } catch {
    console.warn('[tts] ffmpeg-static not available, skipping narration');
    return null;
  }

  const voice = (process.env.AGENT_VOICE as TtsVoice) || DEFAULT_VOICE;
  const client = getTtsClient();
  const tmpDir = path.join('/tmp', `narration-${randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  try {
    const sorted = [...segments].sort((a, b) => a.timestampMs - b.timestampMs);

    const merged: NarrationSegment[] = [];
    for (const seg of sorted) {
      const prev = merged[merged.length - 1];
      if (prev && seg.timestampMs - prev.timestampMs < 2_000) {
        prev.text = `${prev.text} ${seg.text}`;
      } else {
        merged.push({ ...seg });
      }
    }

    console.log(`[tts] ${segments.length} raw segments → ${merged.length} merged segments`);

    const clipPaths: string[] = [];
    let currentMs = 0;

    for (let i = 0; i < merged.length; i++) {
      const seg = merged[i];
      const gapMs = Math.max(0, seg.timestampMs - currentMs);

      if (gapMs > 300) {
        const silenceSec = Math.min(gapMs / 1000, 15).toFixed(3);
        const silencePath = path.join(tmpDir, `silence_${i}.wav`);
        await execFileAsync(ffmpegPath, [
          '-y', '-f', 'lavfi',
          '-i', 'anullsrc=r=24000:cl=mono',
          '-t', silenceSec,
          '-c:a', 'pcm_s16le',
          silencePath,
        ], { timeout: 10_000 });
        clipPaths.push(silencePath);
      }

      const cleanText = seg.text.slice(0, 400).replace(/[^\w\s.,!?;:'"()-]/g, ' ').trim();
      if (!cleanText) continue;

      const speechMp3 = path.join(tmpDir, `speech_${i}.mp3`);
      const speechWav = path.join(tmpDir, `speech_${i}.wav`);
      try {
        const response = await client.audio.speech.create({
          model: 'tts-1',
          voice,
          input: cleanText,
          response_format: 'mp3',
          speed: 1.15,
        });

        const arrayBuf = await response.arrayBuffer();
        await fs.writeFile(speechMp3, Buffer.from(arrayBuf));

        await execFileAsync(ffmpegPath, [
          '-y', '-i', speechMp3,
          '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le',
          speechWav,
        ], { timeout: 10_000 });
        clipPaths.push(speechWav);

        const probe = await execFileAsync(ffmpegPath, [
          '-i', speechWav,
          '-f', 'null', '-',
        ], { timeout: 5_000 }).catch(() => null);
        const durationMatch = probe?.stderr?.match(/Duration: (\d+):(\d+):(\d+)\.(\d+)/);
        let clipDurationMs = 3000;
        if (durationMatch) {
          clipDurationMs = (
            parseInt(durationMatch[1]) * 3600 +
            parseInt(durationMatch[2]) * 60 +
            parseInt(durationMatch[3])
          ) * 1000 + parseInt(durationMatch[4]) * 10;
        }
        currentMs = seg.timestampMs + clipDurationMs;
      } catch (e) {
        console.warn(`[tts] Speech generation failed for segment ${i}:`, e);
        currentMs = seg.timestampMs + 2000;
      }
    }

    if (clipPaths.length === 0) return null;

    const trailingSec = Math.max(
      ((videoDurationMs - currentMs) / 1000),
      1.5,
    ).toFixed(3);
    const trailingSilencePath = path.join(tmpDir, 'silence_trail.wav');
    await execFileAsync(ffmpegPath, [
      '-y', '-f', 'lavfi',
      '-i', 'anullsrc=r=24000:cl=mono',
      '-t', trailingSec,
      '-c:a', 'pcm_s16le',
      trailingSilencePath,
    ], { timeout: 10_000 });
    clipPaths.push(trailingSilencePath);

    const concatList = path.join(tmpDir, 'concat.txt');
    const concatContent = clipPaths.map((p) => `file '${p}'`).join('\n');
    await fs.writeFile(concatList, concatContent);

    const outputPath = path.join(tmpDir, 'narration.mp3');
    await execFileAsync(ffmpegPath, [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', concatList,
      '-c:a', 'libmp3lame', '-q:a', '4',
      outputPath,
    ], { timeout: 30_000 });

    const result = await fs.readFile(outputPath);
    console.log(`[tts] Narration generated: ${(result.length / 1024).toFixed(0)}KB from ${segments.length} segment(s)`);
    return result;
  } catch (e) {
    console.warn('[tts] Narration generation failed:', e);
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
