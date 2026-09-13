/**
 * Typed DEMO data for the UI boundary only.
 * Presentational: no real provider state and no fabricated cost/usage assertions.
 * In this slice only OpenRouter has a real platform-level credential through KIP;
 * other vendors are shown as models available VIA OpenRouter, not direct KIP credentials.
 */

import type {
  AiProvider,
  ChartPoint,
  UsageStat,
  WorkloadModelAssignment,
  ActivityEvent,
} from '../contracts/models';

export const demoProviders: AiProvider[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    taglineI18nKey: 'provider.openrouter.tagline',
    status: 'not_connected',
    apiKeyConfigured: false,
    accentColor: '#4f5ee0',
  },
];

export const viaOpenRouter: AiProvider[] = [
  { id: 'openai', name: 'OpenAI', taglineI18nKey: 'provider.openai.tagline', status: 'not_connected', apiKeyConfigured: false, accentColor: '#10a37f' },
  { id: 'anthropic', name: 'Anthropic', taglineI18nKey: 'provider.anthropic.tagline', status: 'not_connected', apiKeyConfigured: false, accentColor: '#d97757' },
  { id: 'google', name: 'Google (Gemini)', taglineI18nKey: 'provider.google.tagline', status: 'not_connected', apiKeyConfigured: false, accentColor: '#4285F4' },
];

export const modelOptions: string[] = [
  'openrouter/auto',
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3-5-sonnet',
  'google/gemini-1.5-pro',
  'openai/text-embedding-3-small',
];

export const demoWorkloads: WorkloadModelAssignment[] = [
  { workloadKey: 'source_analysis', modelId: 'openai/gpt-4o-mini', recommended: false },
  { workloadKey: 'chat_assistant', modelId: '', recommended: false },
  { workloadKey: 'vision_scan', modelId: '', recommended: false },
  { workloadKey: 'embeddings', modelId: '', recommended: false },
  { workloadKey: 'summarization', modelId: '', recommended: false },
];

export const demoUsageStats: UsageStat[] = [
  { labelI18nKey: 'usage.totalCalls', value: '—', delta: '—', direction: 'up', trendGood: 'up' },
  { labelI18nKey: 'usage.totalTokens', value: '—', delta: '—', direction: 'up', trendGood: 'up' },
  { labelI18nKey: 'usage.totalCost', value: '—', delta: '—', direction: 'down', trendGood: 'down' },
  { labelI18nKey: 'usage.errorRate', value: '—', delta: '—', direction: 'down', trendGood: 'down' },
];

export const demoChart: ChartPoint[] = [{ label: 'today', tokens: 0 }];

export const demoActivity: ActivityEvent[] = [];