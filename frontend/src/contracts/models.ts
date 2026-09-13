/**
 * UI contracts for the KIP Admin "AI & Models" slice.
 * Workload keys are canonical (underscore, matching the backend control-plane).
 */

export type ProviderStatus = 'connected' | 'not_connected' | 'issue';

export type WorkloadKey = 'source_analysis' | 'chat_assistant' | 'vision_scan' | 'summarization' | 'embeddings';

export interface WorkloadModelAssignment {
  workloadKey: WorkloadKey;
  modelId: string;
  recommended: boolean;
}

export interface UsageStat {
  labelI18nKey: string;
  value: string;
  delta: string;
  direction: 'up' | 'down';
  trendGood: 'up' | 'down' | 'flat';
}

export interface AiProvider {
  id: string;
  name: string;
  taglineI18nKey: string;
  status: ProviderStatus;
  apiKeyConfigured: boolean;
  maskedKey?: string;
  modelsAvailable?: number;
  lastCheckedLabel?: string;
  accentColor: string;
}

export interface ChartPoint {
  label: string;
  tokens: number;
}

export interface ActivityEvent {
  timeI18nKey: string;
  actionI18nKey: string;
  provider: string;
  detailI18nKey: string;
  status: 'success' | 'info';
}