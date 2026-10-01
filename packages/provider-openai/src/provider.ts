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
      'You are a drift detector for AI coding agents.',
      'Given an original task and a conversation transcript, determine whether the agent has drifted from its assigned task.',
      'Call the classify_drift tool with your assessment.',
      '',
      'Drift types:',
      '- none: Agent is making progress on the original task, even if taking reasonable intermediate steps.',
      '- scope_creep: Agent is doing MORE than asked — adding features, refactoring code, or making changes beyond the task scope.',
      '- rabbit_hole: Agent is stuck in a debugging spiral or exploring tangents that are not productive toward the goal.',
      '- wrong_approach: Agent is solving the right problem but with a fundamentally wrong or unnecessarily complex strategy.',
      '- task_confusion: Agent is working on a completely different task than what was assigned.',
      '- yak_shaving: Agent is fixing prerequisites of prerequisites, getting further from the actual goal with each step.',
      '',
      'Severity guide:',
      '- 0: On track. Normal progress toward the goal.',
      '- 1: Minor tangent. Small deviation but likely to self-correct.',
      '- 2: Significant drift. Agent has lost focus and is spending effort on the wrong things.',
      '- 3: Completely off task. Agent is doing something unrelated to the original intent.',
      '',
      'Be concise in your explanation (max 150 chars). Focus on WHAT drifted, not restating the original task.',
    ].join('\n');

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
