import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../memory/paths.js';
export type WorkerActivity = { runId: string; tool: string; writes: number; at: number; error: boolean };
export function activityPath(root: string,runId: string) { return join(root,'.runs',`${runId}.activity.json`); }
export function writeActivity(root: string,activity: WorkerActivity) {
 try { atomicWrite(activityPath(root,activity.runId),JSON.stringify(activity)); } catch { /* optional diagnostics */ }
}
export function readActivity(root: string,runId: string): WorkerActivity | undefined {
 try {
  const v=JSON.parse(readFileSync(activityPath(root,runId),'utf8'));
  if (v.runId === runId && ['read','write','edit','ls','grep','record_observations','complete_consolidation'].includes(v.tool) &&
   Number.isSafeInteger(v.writes) && v.writes >= 0 && Number.isFinite(v.at) && typeof v.error === 'boolean') return v;
 } catch { /* no activity yet */ }
 return undefined;
}
