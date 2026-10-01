import OpenAI from 'openai';
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

const CLASSIFY_DRIFT_TOOL: OpenAI.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'classify_drift',
    description: 'Classify whether the conversation has drifted from the original intent.',
    parameters: {
      type: 'object',
      properties: {
        is_drifting: {
          type: 'boolean',
          description: 'Whether the conversation has drifted from the original intent.',
        },
        severity: {
          type: 'number',
          description: 'Severity of drift from 0 (on track) to 3 (completely off task).',
          enum: [0, 1, 2, 3],
        },
        type: {
          type: 'string',
          description: 'The type of drift detected.',
          enum: [
            'none',
            'scope_creep',
            'rabbit_hole',
            'wrong_approach',
            'task_confusion',
            'yak_shaving',
          ],
        },
        explanation: {
          type: 'string',
          description: 'Brief explanation of the drift assessment (max 150 chars).',
          maxLength: 150,
        },
      },
      required: ['is_drifting', 'severity', 'type', 'explanation'],
    },
  },
};

export interface OpenAIDriftProviderOptions {
  baseURL: string;
  apiKey: string;
  model: string;
}

export class OpenAIDriftProvider implements DriftProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIDriftProviderOptions) {
    this.client = new OpenAI({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
    });
    this.model = options.model;
  }

  async check(intent: Intent, messages: Message[]): Promise<DriftResult> {
    const systemPrompt = [
      'You are a drift detector. Analyze the following conversation and determine if it has drifted from the original intent.',
      'Classify the drift using the classify_drift tool.',
      'Consider scope creep, rabbit holes, wrong approaches, task confusion, and yak shaving.',
      'Be concise in your explanation (max 150 characters).',
    ].join(' ');

    const constraintsBlock = intent.constraints?.length
      ? `\nConstraints: ${intent.constraints.join(', ')}`
      : '';

    const contextBlock = intent.context
      ? `\nContext: ${intent.context}`
      : '';

    const formattedMessages = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n');

    const userMessage = [
      `Original Intent: ${intent.description}`,
      constraintsBlock,
      contextBlock,
      '',
      'Conversation:',
      formattedMessages,
    ].join('\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      tools: [CLASSIFY_DRIFT_TOOL],
      tool_choice: {
        type: 'function',
        function: { name: 'classify_drift' },
      },
    });

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!toolCall || toolCall.function.name !== 'classify_drift') {
      throw new Error('Expected classify_drift tool call in response');
    }

    const parsed = JSON.parse(toolCall.function.arguments) as {
      is_drifting: boolean;
      severity: number;
      type: DriftType;
      explanation: string;
    };

    const severity = Math.max(0, Math.min(3, Math.round(parsed.severity)));

    return {
      isDrifting: parsed.is_drifting,
      probability: parsed.is_drifting ? Math.max(0.6, severity / 3) : Math.min(0.4, severity / 3),
      severity,
      severityLabel: SEVERITY_LABELS[severity] ?? 'Unknown',
      type: parsed.type,
      typeConfidence: parsed.is_drifting ? 0.8 : 0.5,
      explanation: parsed.explanation,
      checkedAt: Date.now(),
      messageCount: messages.length,
      windowTokenEstimate: 0,
    };
  }
}
