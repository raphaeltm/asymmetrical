/**
 * Gradium TTS client - generates voice alerts for drift events.
 *
 * The Gradium REST API returns NDJSON lines. The audio lines contain
 * base64-encoded WAV chunks that we concatenate into a single buffer.
 */

export interface GradiumConfig {
  apiKey: string;
  baseURL?: string;
  voiceId?: string;
}

export interface TTSResult {
  /** Base64-encoded WAV audio */
  audioBase64: string;
  /** Sample rate reported by the API */
  sampleRate: number;
}

const DEFAULT_BASE_URL = 'https://api.gradium.ai/api';
const DEFAULT_VOICE_ID = 'YTpq7expH9539ERJ';

export class GradiumClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly voiceId: string;

  constructor(config: GradiumConfig) {
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL ?? DEFAULT_BASE_URL;
    this.voiceId = config.voiceId ?? DEFAULT_VOICE_ID;
  }

  async synthesize(text: string): Promise<TTSResult> {
    const response = await fetch(`${this.baseURL}/speech/tts`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        voice_id: this.voiceId,
        text,
        output_format: 'wav',
      }),
    });

    if (!response.ok) {
      throw new Error(`Gradium TTS failed: ${response.status} ${response.statusText}`);
    }

    const body = await response.text();
    const lines = body.trim().split('\n');

    let sampleRate = 48000;
    const audioChunks: string[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'ready') {
          sampleRate = parsed.sample_rate ?? sampleRate;
        } else if (parsed.type === 'audio' && parsed.audio) {
          audioChunks.push(parsed.audio);
        }
      } catch {
        // Skip non-JSON lines
      }
    }

    // Decode all base64 chunks and concatenate
    const buffers = audioChunks.map((chunk) => Buffer.from(chunk, 'base64'));
    const totalLength = buffers.reduce((sum, b) => sum + b.length, 0);
    const combined = Buffer.concat(buffers, totalLength);

    return {
      audioBase64: combined.toString('base64'),
      sampleRate,
    };
  }
}

/** Generate a spoken alert message from a drift result. */
export function driftAlertText(
  severity: number,
  severityLabel: string,
  type: string,
  explanation: string,
): string {
  const typeLabels: Record<string, string> = {
    none: 'no drift',
    scope_creep: 'scope creep',
    rabbit_hole: 'rabbit hole',
    wrong_approach: 'wrong approach',
    task_confusion: 'task confusion',
    yak_shaving: 'yak shaving',
  };
  const typeName = typeLabels[type] ?? type;
  return `Drift alert. Severity: ${severityLabel}. Type: ${typeName}. ${explanation}`;
}
