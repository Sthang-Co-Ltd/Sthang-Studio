export const WEB_IDENTITY_FILE: string;
export const WEB_IDENTITY_PATH: string;
export const ACTIVATION_HEADER: string;
export interface WebIdentity { schemaVersion: 1; service: 'sthang-studio-web'; version: string; buildId: string }
export function validateWebIdentity(value: unknown, expectedVersion: string): WebIdentity;
export function webSourceIdentity(sourceRoot: string): WebIdentity;
export function studioWebIdentityPlugin(sourceRoot: string): import('vite').Plugin;
