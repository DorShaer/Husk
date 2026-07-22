#!/usr/bin/env bun
/**
 * LifeosAgentAdapter — wraps LifeOS's Inference.ts as a scenario AgentAdapter.
 *
 * Lets scenario.run() drive a LifeOS agent in multi-turn simulations without
 * pulling in the ai-sdk Anthropic provider for the agent-under-test path
 * (scenario's UserSimulatorAgent + JudgeAgent still use ai-sdk directly).
 */

import { inference, type InferenceLevel } from '../../../LIFEOS/TOOLS/Inference.ts';
import { AgentAdapter, AgentRole, type AgentInput, type AgentReturnTypes } from '@langwatch/scenario';

export interface LifeosAgentAdapterOptions {
  systemPrompt?: string;
  level?: InferenceLevel;
  timeout?: number;
  name?: string;
}

export class LifeosAgentAdapter extends AgentAdapter {
  override role = AgentRole.AGENT;
  override name: string;
  private opts: Required<Omit<LifeosAgentAdapterOptions, 'name'>>;

  constructor(options: LifeosAgentAdapterOptions = {}) {
    super();
    this.name = options.name ?? 'pai-agent';
    this.opts = {
      systemPrompt: options.systemPrompt ?? 'You are a helpful assistant.',
      level: options.level ?? 'medium',
      timeout: options.timeout ?? 60_000,
    };
  }

  override async call(input: AgentInput): Promise<AgentReturnTypes> {
    const userPrompt = this.renderMessages(input.messages);

    const result = await inference({
      systemPrompt: this.opts.systemPrompt,
      userPrompt,
      level: this.opts.level,
      timeout: this.opts.timeout,
    });

    if (!result.success) {
      throw new Error(`LifeosAgentAdapter inference failed: ${result.error ?? 'unknown error'}`);
    }

    return result.output.trim();
  }

  private renderMessages(messages: AgentInput['messages']): string {
    return messages
      .map((m) => {
        const role = m.role ?? 'user';
        const content = this.extractText(m.content);
        return `[${role}]: ${content}`;
      })
      .join('\n\n');
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && 'text' in part) return String((part as { text: unknown }).text);
          return '';
        })
        .filter(Boolean)
        .join(' ');
    }
    return JSON.stringify(content);
  }
}
