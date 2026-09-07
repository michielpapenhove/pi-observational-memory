import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerConsolidatorTools } from '../agent/consolidator/tools.js';
import { resolveWithinMemory, listTopics } from '../src/memory/paths.js';
import { renderIndexFile } from '../src/memory/index-render.js';
import { readObserverResult } from '../src/spawn/runs.js';
import { spawnWorker } from '../src/spawn/launch.js';
import { Runtime } from '../src/runtime.js';

const dirs: string[] = [];
function temp() { const d = mkdtempSync(join(tmpdir(), 'om-hardening-')); dirs.push(d); return d; }
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));

describe('fork integrity boundaries', () => {
 it('rejects nested, absolute and internal worker paths', () => {
  const root = temp();
  for (const path of ['.memory/topic.md', 'uuid/topic.md', '../escape.md', join(root, 'topic.md'), '.runs/result.json']) {
   expect(resolveWithinMemory(root, path), path).toBeUndefined();
  }
 });
 it('does not follow symlinks in topic discovery or worker paths', () => {
  const root = temp(), outside = temp();
  writeFileSync(join(outside, 'secret.md'), 'secret');
  symlinkSync(join(outside, 'secret.md'), join(root, 'secret.md'));
  expect(resolveWithinMemory(root, 'secret.md')).toBeUndefined();
  expect(listTopics(root)).toEqual([]);
 });
 it('advertises bare filenames to the worker, matching topic discovery', async () => {
  const root = join(temp(), '.memory', 'session-id'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'auth.md'), '---\nid: auth\nsummary: Authentication\n---\nold');
  const index = renderIndexFile(listTopics(root), 'worker');
  const path = index.match(/`([^`]+)`/)![1];
  const tools = new Map<string, any>();
  registerConsolidatorTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, root);
  await tools.get('write').execute('w', { path, content: 'new' });
  expect(readFileSync(join(root, 'auth.md'), 'utf8')).toBe('new');
  expect(listTopics(root)).toHaveLength(1);
 });
 it('rejects a partially malformed observer result instead of silently filtering', () => {
  const path = join(temp(), 'result.json');
  writeFileSync(path, JSON.stringify({ observations: [{ timestamp: '2026-09-05 22:00', content: 'ok' }, { content: '' }] }));
  expect(() => readObserverResult(path)).toThrow();
 });
 it('runs observers serially even with an old concurrency setting', () => {
  const runtime = new Runtime();
  runtime.config.observerConcurrency = 4;
  expect(runtime.observerSlotsAvailable).toBe(1);
  runtime.observersInFlight.set('a', { controller: new AbortController(), coversUpToId: 'source' });
  expect(runtime.observerSlotsAvailable).toBe(0);
 });
 it('bounds stderr and escalates when a child ignores SIGTERM', async () => {
  const result = await spawnWorker({
   argv: [process.execPath, '-e', "process.on('SIGTERM',()=>{}); process.stderr.write('x'.repeat(100000)); setInterval(()=>{},10)"],
   cwd: temp(), env: process.env, timeoutMs: 500, killGraceMs: 100,
  });
  expect(result.signal).toBe('SIGKILL');
  expect(result.timedOut).toBe(true);
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(16384);
 }, 5000);
});
