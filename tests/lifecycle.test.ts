import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { spawnWorker } from '../src/spawn/launch.js';
import { StatusController } from '../src/ui/status-controller.js';
import { Runtime } from '../src/runtime.js';
import { registerCompactionTrigger } from '../src/hooks/compaction-trigger.js';
import { observation, observationsRecordedEntry, rawMessage } from './fixtures/session.js';
const dirs:string[]=[];
function temp(){const d=mkdtempSync(join(tmpdir(),'om-lifecycle-'));dirs.push(d);return d;}
afterEach(()=>{vi.useRealTimers();dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
it('passes a large prompt through stdin without argv limits or truncation',async()=>{
 const input='abc'.repeat(100000);
 const result=await spawnWorker({argv:[process.execPath,'-e',"let n=0; process.stdin.on('data',b=>n+=b.length); process.stdin.on('end',()=>process.stderr.write(String(n)));"],cwd:temp(),env:process.env,input,timeoutMs:2000});
 expect(result.code).toBe(0); expect(result.stderr).toBe(String(Buffer.byteLength(input)));
});
it('pre-aborted workers never execute',async()=>{
 const controller=new AbortController(); controller.abort();
 const result=await spawnWorker({argv:['this-command-must-never-be-started'],cwd:temp(),env:process.env,signal:controller.signal});
 expect(result.aborted).toBe(true); expect(result.stderr).toContain('before spawn');
});
it('a spawn error settles cleanly',async()=>{
 const result=await spawnWorker({argv:['this-command-does-not-exist-om-test'],cwd:temp(),env:process.env,timeoutMs:500});
 expect(result.code).not.toBe(0); expect(result.stderr).toContain('ENOENT');
});
it('elapsed time and actual tool activity are visible, then detach stops updates',()=>{
 vi.useFakeTimers();vi.setSystemTime(100000);
 const widgets:any[]=[];
 const status=new StatusController();
 status.attach({setStatus:()=>{},setWidget:(_k,value)=>widgets.push(value),theme:{fg:(_c,t)=>t}});
 status.workerStart('consolidator','r');
 vi.advanceTimersByTime(61000);
 status.workerActivity('r',{runId:'r',tool:'write',writes:3,at:Date.now(),error:false});
 vi.advanceTimersByTime(120);
 expect(widgets.at(-1)[0]).toContain('1m01s'); expect(widgets.at(-1)[0]).toContain('3 writes');
 status.detach(); const count=widgets.length; vi.advanceTimersByTime(10000);
 expect(widgets).toHaveLength(count);
});
// ── Compaction on the `turn_end` boundary ──────────────────────────────────────────────────────
// 40 chars ⇒ 10 estimated tokens per raw message.
const body = 'x'.repeat(40);

/**
 * A branch with two committed observation chunks and a 20-token verbatim tail, so the 20-token
 * target snaps onto `raw-4`'s chunk boundary and keeps `raw-5`+`raw-6` verbatim.
 */
function compactionSetup(options: { observed?: boolean; tailTokens?: number } = {}) {
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.configLoaded = true; // never read the developer's real settings.json
	runtime.memoryRoot = mkdtempSync(join(tmpdir(), 'om-compaction-'));
	dirs.push(runtime.memoryRoot);
	runtime.config = { ...runtime.config, tailTokens: options.tailTokens ?? 20, maxTailTokens: 40 };
	const branch: any[] =
		options.observed === false
			? [rawMessage('raw-1', body), rawMessage('raw-2', body)]
			: [
					rawMessage('raw-1', body),
					rawMessage('raw-2', body),
					observationsRecordedEntry('om-1', {
						observations: [observation('2026-05-02T10:00:01', { content: 'first' })],
						coversUpToId: 'raw-2',
					}),
					rawMessage('raw-3', body),
					rawMessage('raw-4', body),
					observationsRecordedEntry('om-2', {
						observations: [observation('2026-05-02T10:05:00', { content: 'second' })],
						coversUpToId: 'raw-4',
					}),
					rawMessage('raw-5', body),
					rawMessage('raw-6', body),
				];
	let handler: any;
	const pi: any = { on: (_name: string, fn: any) => { handler = fn; }, sendMessage: vi.fn() };
	const ctx: any = {
		hasUI: true,
		ui: { notify: vi.fn() },
		cwd: runtime.memoryRoot,
		signal: undefined,
		getContextUsage: () => ({ tokens: 999_999 }),
		sessionManager: { getBranch: () => branch },
	};
	registerCompactionTrigger(pi, runtime);
	const run = (event: Record<string, unknown> = {}) =>
		handler(
			{ outcome: 'completed', entries: [], message: { role: 'assistant', stopReason: 'stop' }, toolResults: [], ...event },
			ctx,
		);
	return { runtime, branch, ctx, pi, run };
}

it('commits the compaction as a boundary draft instead of aborting the loop', async () => {
	const { branch, pi, run } = compactionSetup();
	const result = await run({ toolResults: [{ role: 'toolResult', content: [] }] });

	expect(result.entries).toHaveLength(1);
	const draft = result.entries[0];
	expect(draft.type).toBe('compaction');
	// Snapped onto raw-4's chunk boundary: raw-5 and raw-6 stay verbatim.
	expect(draft.firstKeptEntryId).toBe('raw-5');
	expect(branch.map((entry: any) => entry.id)).toContain(draft.firstKeptEntryId);
	expect(draft.summary).toContain('second');
	// The loop decides on its own whether another turn follows: a boundary draft must not force one.
	expect(result.continue).toBeUndefined();
	// The old workaround injected a hidden user-role resume message; the boundary makes it obsolete.
	expect(pi.sendMessage).not.toHaveBeenCalled();
});

it('compacts a terminal turn too, without restarting it', async () => {
	const { run } = compactionSetup();
	const result = await run({ toolResults: [], message: { role: 'assistant', stopReason: 'stop' } });
	expect(result.entries).toHaveLength(1);
	expect(result.continue).toBeUndefined();
});

it('refuses without a committed observation boundary, leaving the run untouched', async () => {
	const { ctx, pi, run } = compactionSetup({ observed: false });
	expect(await run()).toBeUndefined();
	expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('no confirmed observer boundary'), 'warning');
	expect(pi.sendMessage).not.toHaveBeenCalled();
});

it('never compacts an errored or aborted turn, nor between retry attempts', async () => {
	const { run } = compactionSetup();
	expect(await run({ outcome: 'aborted' })).toBeUndefined();
	expect(await run({ outcome: 'error' })).toBeUndefined();
	expect(
		await run({ message: { role: 'assistant', stopReason: 'error', errorMessage: 'rate limit exceeded (429)' } }),
	).toBeUndefined();
});

it('stays quiet below the threshold', async () => {
	const { ctx, run } = compactionSetup();
	ctx.getContextUsage = () => ({ tokens: 1_000 });
	expect(await run()).toBeUndefined();
});

it('skips the observer wait only when no in-flight observer can enter the block', async () => {
	// Tail-region observer + stable snap ⇒ the block cannot change ⇒ no wait.
	const tailObserver = compactionSetup();
	tailObserver.runtime.observersInFlight.set('run-1', { controller: new AbortController(), coversUpToId: 'raw-6' });
	expect((await tailObserver.run()).entries).toHaveLength(1);
	expect(tailObserver.runtime.lastCompactionObserverWait).toBe('skipped');

	// An observer covering a pre-cutoff chunk can still enter the block ⇒ wait for it.
	const preCutoffObserver = compactionSetup();
	preCutoffObserver.runtime.observersInFlight.set('run-2', { controller: new AbortController(), coversUpToId: 'raw-2' });
	expect((await preCutoffObserver.run()).entries).toHaveLength(1);
	expect(preCutoffObserver.runtime.lastCompactionObserverWait).toBe('waited');
});

it('drops the draft when the session changed while waiting on observers', async () => {
	const { runtime, run } = compactionSetup();
	runtime.observersInFlight.set('run-1', { controller: new AbortController(), coversUpToId: 'raw-2' });
	let release!: () => void;
	runtime.trackObserverTask(new Promise<void>((resolve) => { release = resolve; }));
	const pending = run();
	// om switched off / session replaced mid-wait: the draft belongs to a session that is gone.
	runtime.abortAllWorkers();
	release();
	expect(await pending).toBeUndefined();
});
