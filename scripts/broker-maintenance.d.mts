export interface BrokerMaintenanceResult {
  status: 'skipped' | 'deferred' | 'current' | 'updated';
  brokerVersion?: string;
}
export function maintainActiveBroker(options: {
  installRoot: string;
  sourceRoot: string;
}): Promise<BrokerMaintenanceResult>;

export function brokerSessionNotice(result: BrokerMaintenanceResult, loadedBrokerVersion?: string): string | null;
