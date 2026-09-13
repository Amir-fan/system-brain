/**
 * Typed DEMO data for the UI boundary only.
 * This is presentational: no real provider state, no fake cost/usage assertions.
 * All values here are clearly demo placeholders until the backend supplies them.
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
    id: 'openai',
    name: 'OpenAI',
    taglineI18nKey: 'provider.openai.tagline',
    status: 'connected',
    apiKeyConfigured: true,
    maskedKey: 'sk-••••••••••••3Kx9',
    modelsAvailable: 12,
    lastCheckedLabel: 'common.minutesAgo',
    accentColor: '#10a37f',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    taglineI18nKey: 'provider.anthropic.tagline',
    status: 'not_connected',
    apiKeyConfigured: false,
    accentColor: '#d97757',
  },
  {
    id: 'google',
    name: 'Google',
    taglineI18nKey: 'provider.google.tagline',
    status: 'not_connected',
    apiKeyConfigured: false,
    accentColor: '#4285F4',
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    taglineI18nKey: 'provider.azure.tagline',
    status: 'not_connected',
    apiKeyConfigured: false,
    accentColor: '#0078d4',
  },
];

export const modelOptions: string[] = [
  'gpt-4o-mini',
  'gpt-4o',
  'claude-3-5-sonnet',
  'gemini-1.5-pro',
  'text-embedding-3-small',
];

export const demoWorkloads: WorkloadModelAssignment[] = [
  { workloadKey: 'source-analysis', modelId: 'gpt-4o-mini', recommended: true },
  { workloadKey: 'smart-scan', modelId: 'gpt-4o-mini', recommended: false },
  { workloadKey: 'chat-assistant', modelId: 'gpt-4o-mini', recommended: false },
  { workloadKey: 'embeddings', modelId: 'text-embedding-3-small', recommended: false },
  { workloadKey: 'summarization', modelId: 'gpt-4o-mini', recommended: false },
];

export const demoUsageStats: UsageStat[] = [
  { labelI18nKey: 'usage.totalCalls', value: '1,248', delta: '+12%', direction: 'up', trendGood: 'up' },
  { labelI18nKey: 'usage.totalTokens', value: '892,432', delta: '+18%', direction: 'up', trendGood: 'up' },
  { labelI18nKey: 'usage.totalCost', value: '$2.41', delta: '-23%', direction: 'down', trendGood: 'down' },
  { labelI18nKey: 'usage.errorRate', value: '0.8%', delta: '-60%', direction: 'down', trendGood: 'down' },
];

export const demoChart: ChartPoint[] = [
  { label: '14', tokens: 24000 },
  { label: '16', tokens: 32000 },
  { label: '18', tokens: 28000 },
  { label: '20', tokens: 43000 },
  { label: '22', tokens: 51000 },
  { label: '24', tokens: 47000 },
  { label: '26', tokens: 61000 },
  { label: '28', tokens: 68000 },
  { label: '30', tokens: 59000 },
  { label: '2', tokens: 72000 },
  { label: '4', tokens: 66000 },
  { label: '6', tokens: 78432 },
  { label: '8', tokens: 70000 },
  { label: '10', tokens: 64000 },
];

export const demoActivity: ActivityEvent[] = [
  { timeI18nKey: 'activity.twoMin', actionI18nKey: 'activity.connTest', provider: 'OpenAI', detailI18nKey: 'activity.connOk', status: 'success' },
  { timeI18nKey: 'activity.oneHour', actionI18nKey: 'activity.modelUpdated', provider: 'OpenAI', detailI18nKey: 'activity.chatModel', status: 'success' },
  { timeI18nKey: 'activity.threeHours', actionI18nKey: 'activity.providerAdded', provider: 'OpenAI', detailI18nKey: 'activity.providerConfigured', status: 'success' },
  { timeI18nKey: 'activity.oneDay', actionI18nKey: 'activity.modelUpdated', provider: 'OpenAI', detailI18nKey: 'activity.sourceModel', status: 'success' },
];