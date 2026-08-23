import fs from 'node:fs/promises';
import path from 'node:path';
import type { CaptionProject } from '@kcs/shared';
import { config } from '../config.js';

async function load(): Promise<CaptionProject[]> {
  try {
    return JSON.parse(await fs.readFile(config.dataFile, 'utf8')) as CaptionProject[];
  } catch {
    return [];
  }
}

async function save(items: CaptionProject[]) {
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });
  await fs.writeFile(config.dataFile, JSON.stringify(items, null, 2), 'utf8');
}

export const store = {
  async list() { return load(); },
  async get(id: string) { return (await load()).find((x) => x.id === id) ?? null; },
  async upsert(project: CaptionProject) {
    const all = await load();
    const i = all.findIndex((x) => x.id === project.id);
    if (i >= 0) all[i] = project; else all.unshift(project);
    await save(all);
    return project;
  },
  async remove(id: string) {
    const all = await load();
    await save(all.filter((x) => x.id !== id));
  }
};
