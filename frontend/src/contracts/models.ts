/**
 * UI contracts for the KIP Admin "AI & Models" slice.
 * These define the data shapes the frontend renders. They are DESIGN contracts —
 * the backend capabilities that populate them are listed as integration gaps.
 */

export type ProviderStatus = 'connected' | 'not_connected' | 'issue';

export interface AiProvider {
  id: string;
  name: string;
  taglineI18nKey: string; // dictionary key for the one-line description
  status: ProviderStatus;
  apiKeyConfigured: boolean;
  /** Masked display of a configured key (never the real value). */
  maskedKey?: string;
  modelsAvailable?: number;
  lastCheckedLabel?: string;
  accentColor: string;
}

export type WorkloadKey = 'source-analysis' | 'smart-scan' | 'chat-assistant' | 'embeddings' | 'summarization';

export interface WorkloadModelAssignment {
  workloadKey: WorkloadKey;
  modelId: string;
  recommended: boolean;
}

export interface UsageStat {
  labelI18nKey: string;
  value: string;
  delta: string; // e.g. "+12%"
  direction: 'up' | 'down';
  trendGood: 'up' | 'down' | 'flat';
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