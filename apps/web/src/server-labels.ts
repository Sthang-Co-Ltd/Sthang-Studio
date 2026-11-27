import { looksMessages } from './i18n/messages/en/looks';
import { serverMessages } from './i18n/messages/en/server';
import type { Locale, MessageKey } from './i18n/types';

function hasCode<Catalog extends object>(catalog: Catalog, code: string): code is keyof Catalog & string {
  return Object.hasOwn(catalog, code);
}

function exactLabelKeys<Prefix extends string, Labels extends Record<string, string>>(
  prefix: Prefix, labels: Labels,
): ReadonlyMap<string, `${Prefix}.${keyof Labels & string}`> {
  const keys = Object.keys(labels) as (keyof Labels & string)[];
  return new Map(keys.map((key) => [labels[key], `${prefix}.${key}` as const]));
}

// Use the English catalog values as the exact persisted server labels.
const historyLabelKeys = exactLabelKeys('server.historyLabel', serverMessages.historyLabel);
const candidateLabelKeys = exactLabelKeys('server.candidateLabel', serverMessages.candidateLabel);
const selectedCandidateReasonKeys = exactLabelKeys('server.selectedCandidateReason', serverMessages.selectedCandidateReason);

export function activityMessageKey(locale: Locale, stage: string, canResume?: boolean): MessageKey | undefined {
  if (locale !== 'km') return undefined;
  if (stage === 'interrupted' && canResume) return 'server.resumable.interrupted';
  if (hasCode(serverMessages.stage, stage)) return `server.stage.${stage}`;
}

export function activityStageNameKey(stage: string) {
  if (hasCode(serverMessages.stageName, stage)) return `server.stageName.${stage}` as const;
}

export function historySourceKey(source: string) {
  if (hasCode(serverMessages.historySource, source)) return `server.historySource.${source}` as const;
}

export function historyLabelKey(label: string) {
  return historyLabelKeys.get(label);
}

export function candidateLabelKey(label: string) {
  return candidateLabelKeys.get(label);
}

export function selectedCandidateReasonKey(reason: string) {
  return selectedCandidateReasonKeys.get(reason);
}

export function lookNameKey(id: string) {
  if (hasCode(looksMessages, id)) return `looks.${id}` as const;
}
