export const pendingKhmerNamespaces = ['settings', 'privacy', 'system', 'dialogs', 'notices', 'server', 'looks'] as const;
export type PendingKhmerNamespace = typeof pendingKhmerNamespaces[number];
