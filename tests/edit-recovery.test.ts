import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { registerConsolidatorTools } from '../agent/consolidator/tools.js';
import { cleanWorkerEnd, makeRequest } from '../src/spawn/receipt.js';
import * as memoryPaths from '../src/memory/paths.js';

const dirs: string[] = [];
afterEach(() => {
 vi.restoreAllMocks();
 dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
const original = 'Agreed direction: the game is not pushed back into its original format as it grows; pickup counts immediately.';
function setup(body = original) {
 const root = mkdtempSync(join(tmpdir(), 'om-edit-recovery-')); dirs.push(root);
 const content = `---\nid: facts\ntitle: Facts\nsummary: Project facts\nupdated: 2026-09-08\n---\n${body}\n`;
 writeFileSync(join(root, 'facts.md'), content);
 const tools = new Map<string, any>();
 const worker = registerConsolidatorTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, root,
  makeRequest('cons-test', 'consolidator', 'input', ['a']));
 const call = (id: string, name: string, args: any) => tools.get(name).execute(id, args);
 const edit = (id: string, oldText: string, newText = 'updated') => call(id, 'edit', { path: 'facts.md', oldText, newText });
 const complete = () => call('done', 'complete_consolidation', { dispositions: [{ timestamp: 'a', path: 'facts.md' }] });
 return { root, content, worker, call, edit, complete };
}

it.each([
 ['missing', original, 'Agreed direction: pickup counts immediately.', 'oldText not found'],
 ['ambiguous', 'alpha beta alpha', 'alpha', 'oldText is ambiguous'],
])('a %s match changes no bytes, allows rereading and an exact repair, then completion', async (_kind, body, oldText, message) => {
 const { root, content, worker, call, edit, complete } = setup(body);
 await expect(edit('mismatch', oldText)).rejects.toThrow(message);
 expect(readFileSync(join(root, 'facts.md'), 'utf8')).toBe(content);
 expect(worker.failure()).toBeUndefined();
 expect(worker.recoverableErrors.has('mismatch')).toBe(true);
 expect(worker.result()).toBeUndefined();
 expect((await call('reread', 'read', { path: 'facts.md' })).content[0].text).toBe(content);
 await edit('repair', body, 'Repaired fact.');
 await complete();
 expect(worker.result()?.dispositions[0].path).toBe('facts.md');
 expect(cleanWorkerEnd({ messages: [
  { role: 'toolResult', toolName: 'edit', toolCallId: 'mismatch', isError: true },
  { role: 'assistant', stopReason: 'stop' },
 ] }, worker.recoverableErrors)).toBe(true);
});

it('a mismatch tells the model which file to reread, that nothing changed, and the recovery budget', async () => {
 const { edit } = setup();
 await expect(edit('bad', 'missing')).rejects.toThrow('No file changes');
 await expect(edit('bad2', 'missing')).rejects.toThrow('Read facts.md again');
 await expect(edit('bad3', 'missing')).rejects.toThrow('3/3');
});

it('the fourth mismatch is fatal even with successful edits between errors', async () => {
 const { root, worker, edit, complete } = setup();
 for (let i = 0; i < 3; i++) {
  await expect(edit(`bad-${i}`, 'missing')).rejects.toThrow('oldText not found');
  await edit(`ok-${i}`, 'pickup', 'pickup');
 }
 const before = readFileSync(join(root, 'facts.md'), 'utf8');
 await expect(edit('exhausted', 'missing')).rejects.toThrow('edit correction limit reached');
 expect(worker.recoverableErrors.size).toBe(3);
 expect(worker.recoverableErrors.has('exhausted')).toBe(false);
 expect(worker.failure()).toContain('oldText not found');
 expect(readFileSync(join(root, 'facts.md'), 'utf8')).toBe(before);
 await expect(complete()).rejects.toThrow('tool errors');
 expect(worker.result()).toBeUndefined();
});

it('edit and confirmation corrections have independent budgets', async () => {
 const { worker, call, edit, complete } = setup();
 for (let i = 0; i < 3; i++) {
  await expect(edit(`edit-${i}`, 'missing')).rejects.toThrow('oldText not found');
  await expect(call(`ack-${i}`, 'complete_consolidation', { dispositions: [] })).rejects.toThrow('every observation');
 }
 await edit('repair', original, 'Corrected fact.');
 await complete();
 expect(worker.failure()).toBeUndefined();
 expect(worker.result()?.dispositions).toHaveLength(1);
});

it.each([
 ['path traversal', '../outside.md', 'missing', 'escapes .memory/'],
 ['generated index', 'INDEX.md', 'missing', 'generated automatically'],
 ['missing file', 'absent.md', 'missing', 'ENOENT'],
 ['empty search', 'facts.md', '', 'oldText must not be empty'],
])('%s remains fatal after a recoverable mismatch', async (_kind, path, oldText, message) => {
 const { worker, call, edit, complete } = setup();
 await expect(edit('recoverable', 'missing')).rejects.toThrow('oldText not found');
 await expect(call('fatal', 'edit', { path, oldText, newText: 'x' })).rejects.toThrow(message);
 expect(worker.recoverableErrors.has('fatal')).toBe(false);
 expect(worker.failure()).toContain(message);
 await expect(complete()).rejects.toThrow('tool errors');
 expect(worker.result()).toBeUndefined();
});

it('symlink targets remain fatal', async () => {
 const { root, worker, call } = setup();
 symlinkSync(join(root, 'facts.md'), join(root, 'alias.md'));
 await expect(call('symlink', 'edit', { path: 'alias.md', oldText: original, newText: 'x' })).rejects.toThrow('symlinks forbidden');
 expect(worker.recoverableErrors.size).toBe(0);
});

it('oversized replacement failure is fatal and preserves the file', async () => {
 const { root, content, worker, edit } = setup();
 await expect(edit('large', original, 'x'.repeat(512 * 1024))).rejects.toThrow('exceeds 512 KiB');
 expect(readFileSync(join(root, 'facts.md'), 'utf8')).toBe(content);
 expect(worker.failure()).toContain('exceeds 512 KiB');
 expect(worker.recoverableErrors.size).toBe(0);
});

it('storage failure remains fatal even if its message resembles a match error', async () => {
 const { root, content, worker, edit, complete } = setup();
 vi.spyOn(memoryPaths, 'atomicWrite').mockImplementationOnce(() => { throw new Error('oldText not found (simulated storage failure)'); });
 await expect(edit('storage', original, 'Changed.')).rejects.toThrow('simulated storage failure');
 expect(readFileSync(join(root, 'facts.md'), 'utf8')).toBe(content);
 expect(worker.recoverableErrors.size).toBe(0);
 expect(worker.failure()).toContain('simulated storage failure');
 await expect(complete()).rejects.toThrow('tool errors');
 expect(worker.result()).toBeUndefined();
});

it('edits after accepted completion are still fatal, even when the text would not match', async () => {
 const { worker, edit, complete } = setup();
 await complete();
 await expect(edit('late', 'missing')).rejects.toThrow('completion already submitted');
 expect(worker.result()).toBeUndefined();
 expect(worker.recoverableErrors.size).toBe(0);
});

it('recovery only pardons tracked edit/confirmation errors, never arbitrary tool or model failures', () => {
 const allowed = new Set(['repairable']);
 const stop = { role: 'assistant', stopReason: 'stop' };
 for (const toolName of ['read', 'write', 'grep', 'ls']) {
  expect(cleanWorkerEnd({ messages: [{ role: 'toolResult', toolName, toolCallId: 'repairable', isError: true }, stop] }, allowed)).toBe(false);
 }
 expect(cleanWorkerEnd({ messages: [{ role: 'toolResult', toolName: 'edit', toolCallId: 'untracked', isError: true }, stop] }, allowed)).toBe(false);
 for (const stopReason of ['error', 'aborted', 'length']) {
  expect(cleanWorkerEnd({ messages: [
   { role: 'toolResult', toolName: 'edit', toolCallId: 'repairable', isError: true },
   { role: 'assistant', stopReason }, stop,
  ] }, allowed)).toBe(false);
 }
});
