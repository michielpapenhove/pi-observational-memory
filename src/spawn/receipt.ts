import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveWithinMemory, parseFrontMatter, atomicWrite } from '../memory/paths.js';
import { runResultPath } from './runs.js';

export type WorkerRequest = { version: 2; runId: string; role: 'observer' | 'consolidator'; inputHash: string; ids: string[] };
export type Disposition = { timestamp: string; path?: string; reason?: string; hash?: string };
export const hashText = (text: string) => createHash('sha256').update(text).digest('hex');
export function makeRequest(runId: string, role: WorkerRequest['role'], input: string, ids: string[]): WorkerRequest {
 return { version: 2, runId, role, inputHash: hashText(input), ids };
}
export function readRequest(path: string): WorkerRequest {
 const r = JSON.parse(readFileSync(path, 'utf8'));
 if (r?.version !== 2 || !/^[a-zA-Z0-9-]+$/.test(r.runId) || !['observer','consolidator'].includes(r.role) ||
  !/^[a-f0-9]{64}$/.test(r.inputHash) || !Array.isArray(r.ids) || !r.ids.length ||
  !r.ids.every((id: unknown) => typeof id === 'string' && id.length > 0) || new Set(r.ids).size !== r.ids.length) throw new Error('invalid worker request');
 return r;
}
export function topicHash(root: string, path: string): string {
 const absolute = resolveWithinMemory(root, path);
 if (!absolute || path === '.' || path === 'INDEX.md' || path === 'JOURNEY.md') throw new Error(`invalid topic: ${path}`);
 const text = readFileSync(absolute, 'utf8');
 const { front, body } = parseFrontMatter(text);
 if (front.id !== path.slice(0,-3) || !front.title?.trim() || !front.summary?.trim() || !front.updated?.trim() || !body.trim()) throw new Error(`incomplete topic: ${path}`);
 return hashText(text);
}
/** This verifies accounting and file bytes, NOT the semantic truth of the model's summary. */
export function validateDispositions(root: string, ids: string[], values: unknown, checkHashes = false): Disposition[] {
 if (!Array.isArray(values)) throw new Error('completion must supply a dispositions array');
 const expected = new Set(ids), seen = new Set<string>();
 const unknown: string[] = [], duplicates: string[] = [];
 for (const value of values) {
  const id = value?.timestamp;
  if (typeof id !== 'string') throw new Error('each disposition requires a timestamp ID');
  if (!expected.has(id)) unknown.push(id);
  if (seen.has(id)) duplicates.push(id);
  seen.add(id);
 }
 const missing = ids.filter(id => !seen.has(id));
 if (missing.length || unknown.length || duplicates.length || values.length !== ids.length) {
  const list = (items: string[]) => items.slice(0,50).join(', ') + (items.length > 50 ? ` (+${items.length-50} more)` : '');
  throw new Error(`completion must account for every observation: expected ${ids.length}, received ${values.length}. ` +
   `Missing: ${list(missing) || 'none'}. Unknown: ${list(unknown) || 'none'}. Duplicates: ${list(duplicates) || 'none'}. ` +
   'Resubmit the FULL corrected dispositions array, not just the missing entries.');
 }
 return values.map((v: any) => {
  if (typeof v.path === 'string' && v.reason === undefined) {
   const hash = topicHash(root, v.path);
   if (checkHashes && hash !== v.hash) throw new Error(`topic changed after completion: ${v.path}`);
   return { timestamp: v.timestamp, path: v.path, hash };
  }
  if (v.path === undefined && typeof v.reason === 'string' && v.reason.trim()) return { timestamp: v.timestamp, reason: v.reason.trim() };
  throw new Error('each observation needs a topic or an explicit discard reason');
 });
}
export function readReceipt(root: string, request: WorkerRequest): any {
 let raw: any;
 try { raw = JSON.parse(readFileSync(runResultPath(root, request.runId), 'utf8')); }
 catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${request.role} ended without a valid completion receipt; no observations were removed`);
  throw error;
 }
 if (raw?.version !== 2 || raw.runId !== request.runId || raw.inputHash !== request.inputHash || raw.role !== request.role) throw new Error('missing or mismatched completion receipt');
 if (raw.complete === false && typeof raw.error === 'string') throw new Error(`${request.role} did not complete: ${raw.error.slice(0,2000)}`);
 if (raw.complete !== true) throw new Error('missing or mismatched completion receipt');
 if (request.role === 'consolidator') raw.dispositions = validateDispositions(root, request.ids, raw.dispositions, true);
 return raw;
}
/** Best-effort failure detail even when the worker exits nonzero or is aborted. Never an ACK. */
export function readFailure(root: string, request: WorkerRequest): string | undefined {
 try {
  const raw = JSON.parse(readFileSync(runResultPath(root,request.runId),'utf8'));
  if (raw?.version === 2 && raw.runId === request.runId && raw.inputHash === request.inputHash && raw.role === request.role && raw.complete === false && typeof raw.error === 'string') return raw.error.slice(0,2000);
 } catch { /* missing or incomplete failure handoff */ }
 return undefined;
}
export function writeReceipt(path: string, request: WorkerRequest, result: object): void {
 atomicWrite(path, JSON.stringify({ ...result, ...request, complete: true }));
}
export function writeFailure(path: string, request: WorkerRequest, error: string): void {
 atomicWrite(path, JSON.stringify({ ...request, complete: false, error: error.slice(0,2000) }));
}
export function cleanWorkerEnd(event: any, recoverableErrors: ReadonlySet<string> = new Set()): boolean {
 const messages: any[] = event?.messages ?? [];
 const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
 return lastAssistant?.stopReason === 'stop' && !messages.some(m =>
  (m.role === 'toolResult' && m.isError && !(m.toolName === 'complete_consolidation' && recoverableErrors.has(m.toolCallId))) ||
  (m.role === 'assistant' && ['error','aborted','length'].includes(m.stopReason)));
}
