/**
 * Jev (TypeSafe) drift classification provider.
 *
 * Jev is a non-generative "System One" classifier model that returns typed
 * answers (noul, choice, score) with calibrated probabilities. It's ideal
 * for drift detection: fast (<100ms), cheap ($0.042/M input tokens, free
 * output), and 32K context window.
 *
 * Available on:
 *   - Cloudflare Workers AI: env.AI.run('typesafe/jev', ...)
 *   - Vercel AI Gateway: typesafe-ai/jev
 *   - Direct API: https://api.typesafe.ai/v1/systemone
 *   - OpenRouter: jev-latest
 *
 * This provider supports both the direct REST API and the Cloudflare
 * Workers AI binding (for use inside SAM or other CF Workers).
 */

import type {
  DriftProvider,
  Message,
  Intent,
  DriftResult,
  DriftType,
} from '@asymmetrical/core';

const SEVERITY_LABELS: Record<number, string> = {
  0: 'On track',
  1: 'Minor tangent',
  2: 'Significant drift',
  3: 'Completely off task',
};

const DRIFT_TYPE_CRITERIA: Record<string, string> = {
  none: 'Agent is making progress on the original task',
  scope_creep: 'Agent is adding features, refactoring, or making changes beyond the task scope',
  rabbit_hole: 'Agent is stuck debugging or exploring tangents not productive toward the goal',
  wrong_approach: 'Agent is solving the right problem with a wrong or overly complex strategy',
  task_confusion: 'Agent is working on a completely different task',
  yak_shaving: 'Agent is fixing prerequisites of prerequisites, far from the actual goal',
};

export interface JevDriftProviderOptions {
  /** Direct API key for api.typesafe.ai */
  apiKey?: string;
  /** Override base URL (default: https://api.typesafe.ai/v1) */
  baseURL?: string;
  /**
   * Cloudflare Workers AI binding — pass env.AI when running inside
   * a Cloudflare Worker. Takes precedence over apiKey.
   */
  cloudflare?: { run: (model: string, input: unknown) => Promise<unknown> };
}

export class JevDriftProvider implements DriftProvider {
  private readonly apiKey?: string;
  private readonly baseURL: string;
  private readonly cloudflare?: { run: (model: string, input: unknown) => Promise<unknown> };

  constructor(options: JevDriftProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL ?? 'https://api.typesafe.ai/v1';
    this.cloudflare = options.cloudflare;

    if (!this.apiKey && !this.cloudflare) {
      throw new Error('JevDriftProvider requires either apiKey or cloudflare binding');
    }
  }

  async check(intent: Intent, messages: Message[]): Promise<DriftResult> {
    const state = this.formatState(intent, messages);

    const questions = {
      is_drifting: {
        type: 'noul' as const,
        instructions: 'Is the agent drifting from the original task?',
        criteria: {
          true: 'The agent is working on something different from the stated task, has gone down a rabbit hole, or is solving the wrong problem',
          false: 'The agent is making progress toward the original goal, even if taking a reasonable intermediate step',
        },
      },
      drift_severity: {
        type: 'score' as const,
        instructions: 'How far has the conversation drifted from the original intent?',
        criteria: ['On track', 'Minor tangent', 'Significant drift', 'Completely off task'],
      },
      drift_type: {
        type: 'choice' as const,
        instructions: 'What kind of drift is occurring?',
        criteria: DRIFT_TYPE_CRITERIA,
      },
    };

    const input = { state, questions };

    let response: JevResponse;

    if (this.cloudflare) {
      response = (await this.cloudflare.run('typesafe/jev', input)) as JevResponse;
    } else {
      const res = await fetch(`${this.baseURL}/systemone`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });

      if (!res.ok) {
        throw new Error(`Jev API error: ${res.status} ${res.statusText}`);
      }

      response = (await res.json()) as JevResponse;
    }

    return this.parseResponse(response, messages.length);
  }

  private formatState(intent: Intent, messages: Message[]): string {
    const parts = [`Original Task: ${intent.description}`];
    if (intent.constraints?.length) {
      parts.push(`Constraints: ${intent.constraints.join(', ')}`);
    }
    if (intent.context) {
      parts.push(`Context: ${intent.context}`);
    }
    parts.push('', 'Conversation:');
    for (const m of messages) {
      parts.push(`[${m.role}]: ${m.content}`);
    }
    return parts.join('\n');
  }

  private parseResponse(response: JevResponse, messageCount: number): DriftResult {
    const answers = response.answers;

    const probability = answers.is_drifting?.noul ?? 0;
    const severityRaw = answers.drift_severity?.score ?? 0;
    const severity = Math.max(0, Math.min(3, Math.round(severityRaw)));
    const type = (answers.drift_type?.choice ?? 'none') as DriftType;
    const typeConfidence = answers.drift_type?.confidence ?? 0;

    return {
      isDrifting: probability >= 0.5,
      probability,
      severity,
      severityLabel: SEVERITY_LABELS[severity] ?? 'Unknown',
      type,
      typeConfidence,
      explanation: `Jev: drift=${(probability * 100).toFixed(0)}%, severity=${severityRaw.toFixed(1)}, type=${type}`,
      checkedAt: Date.now(),
      messageCount,
      windowTokenEstimate: 0,
    };
  }
}

// --- Jev response types ---

interface JevNoulAnswer {
  type: 'noul';
  noul: number;
}

interface JevChoiceAnswer {
  type: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface JevScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

interface JevResponse {
  model: string;
  answers: {
    is_drifting?: JevNoulAnswer;
    drift_severity?: JevScoreAnswer;
    drift_type?: JevChoiceAnswer;
  };
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
