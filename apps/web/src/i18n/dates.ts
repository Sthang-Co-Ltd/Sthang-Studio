import type { Locale } from './types';

const khmerMonths = [
  'មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា',
  'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ',
];

export function formatInterfaceDate(locale: Locale, value: Date | string | number, options?: { time?: boolean }): string {
  const date = value instanceof Date ? value : new Date(value);
  if (locale === 'en' || !Number.isFinite(date.getTime())) {
    return options?.time ? date.toLocaleString() : date.toLocaleDateString();
  }
  const day = `${date.getDate()} ${khmerMonths[date.getMonth()]} ${String(date.getFullYear()).padStart(4, '0')}`;
  if (!options?.time) return day;
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day} · ${hours}:${minutes}`;
}
