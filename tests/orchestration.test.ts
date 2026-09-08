import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/spawn/launch.js', async original => ({...await original<any>(),spawnWorker:vi.fn()}));
import { spawnWorker } from '../src/spawn/launch.js';
import { readRequest, writeReceipt, writeFailure } from '../src/spawn/receipt.js';
import { runResultPath } from '../src/spawn/runs.js';
import { evaluateObserverTriggers } from '../src/hooks/observer-trigger.js';
import { evaluateConsolidatorTrigger } from '../src/hooks/consolidator-trigger.js';
import { registerCompactionHook } from '../src/hooks/compaction-hook.js';
import { latestCoverageMarkerId, OM_OBSERVATIONS_RECORDED, OM_OBSERVATIONS_DROPPED } from '../src/ledger/index.js';
import { Runtime } from '../src/runtime.js';
import { rawMessage, observationsRecordedEntry, observation } from './fixtures/session.js';
const dirs:string[] = [];
afterEach(()=>{vi.resetAllMocks(); dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
function setup() {
 const runtime = new Runtime(); runtime.enabled = true; runtime.configLoaded = true;
 runtime.memoryRoot = mkdtempSync(join(tmpdir(),'om-orchestration-')); dirs.push(runtime.memoryRoot);
 runtime.config = {...runtime.config,chunkTokens:100,poolTargetTokens:1,consolidateAtPoolTokens:5};
 const branch:any[] = [rawMessage('a','a'.repeat(800)),rawMessage('b','b'.repeat(800)),rawMessage('c','c'.repeat(800))];
 const pi:any = {appendEntry:vi.fn((customType,data)=>branch.push({type:'custom',id:`ledger-${branch.length}`,customType,data}))};
 const ctx:any = {hasUI:false,sessionManager:{getBranch:()=>branch,getEntries:()=>branch}};
 return {runtime,branch,pi,ctx};
}
function gate() { let resolve!:(value:any)=>void; const promise = new Promise<any>(r=>resolve=r); return {promise,resolve}; }
const exit = {code:0,signal:null,stderr:''};
async function finishObservers(runtime:Runtime) { await runtime.whenObserversIdle(); }
async function finishConsolidator(runtime:Runtime) { for(let n=0;n<30 && runtime.consolidatorInFlight;n++) await new Promise(r=>setImmediate(r)); expect(runtime.consolidatorInFlight).toBe(false); }
it('does not skip a failed chunk; retry commits before the next dispatch, including empty chunks',async()=>{
 const {runtime,pi,ctx} = setup(); const first=gate();
 vi.mocked(spawnWorker).mockReturnValueOnce(first.promise);
 evaluateObserverTriggers(pi,runtime,ctx); evaluateObserverTriggers(pi,runtime,ctx);
 expect(spawnWorker).toHaveBeenCalledTimes(1);
 const firstRequest = readRequest(vi.mocked(spawnWorker).mock.calls[0][0].env.OM_REQUEST_PATH!);
 first.resolve({...exit,code:1}); await finishObservers(runtime);
 expect(pi.appendEntry).not.toHaveBeenCalled();
 evaluateObserverTriggers(pi,runtime,ctx); expect(spawnWorker).toHaveBeenCalledTimes(1); // backoff
 runtime.observerRetryAt = 0;
 vi.mocked(spawnWorker).mockImplementationOnce(async opts=>{
  const request=readRequest(opts.env.OM_REQUEST_PATH!); expect(request.ids).toEqual(firstRequest.ids);
  writeReceipt(runResultPath(opts.cwd,request.runId),request,{observations:[]}); return exit;
 });
 evaluateObserverTriggers(pi,runtime,ctx); await finishObservers(runtime);
 expect(latestCoverageMarkerId(ctx.sessionManager.getBranch(),OM_OBSERVATIONS_RECORDED)).toBe('a');
 const next=gate(); vi.mocked(spawnWorker).mockReturnValueOnce(next.promise);
 evaluateObserverTriggers(pi,runtime,ctx);
 expect(readRequest(vi.mocked(spawnWorker).mock.calls[2][0].env.OM_REQUEST_PATH!).ids).toEqual(['b']);
 next.resolve({...exit,code:1}); await finishObservers(runtime);
});
it('late success after off/on cannot commit, and the old worker holds its slot until close',async()=>{
 const {runtime,pi,ctx} = setup(); const pending=gate();
 vi.mocked(spawnWorker).mockReturnValueOnce(pending.promise);
 evaluateObserverTriggers(pi,runtime,ctx);
 runtime.abortAllWorkers(); evaluateObserverTriggers(pi,runtime,ctx);
 expect(spawnWorker).toHaveBeenCalledTimes(1);
 pending.resolve(exit); await finishObservers(runtime);
 expect(pi.appendEntry).not.toHaveBeenCalled(); expect(runtime.lastWorkerError).toBeUndefined();
 expect(runtime.observerSlotsAvailable).toBe(1);
});
it('a nonzero worker exit preserves the explicit failure reason and the entire batch',async()=>{
 const {runtime,branch,pi,ctx}=setup();
 branch.push(observationsRecordedEntry('obs',{observations:[observation('one'),observation('two')],coversUpToId:'a'}));
 vi.mocked(spawnWorker).mockImplementationOnce(async opts=>{
  const request=readRequest(opts.env.OM_REQUEST_PATH!);
  writeFailure(runResultPath(opts.cwd,request.runId),request,'confirmation correction limit reached');
  return {...exit,code:1};
 });
 evaluateConsolidatorTrigger(pi,runtime,ctx);await finishConsolidator(runtime);
 expect(pi.appendEntry).not.toHaveBeenCalled();
 expect(runtime.lastWorkerError).toContain('confirmation correction limit');
});
it('exit zero without a receipt retains the entire consolidation batch',async()=>{
 const {runtime,branch,pi,ctx} = setup();
 branch.push(observationsRecordedEntry('obs',{observations:[observation('one'),observation('two')],coversUpToId:'a'}));
 vi.mocked(spawnWorker).mockResolvedValue(exit);
 evaluateConsolidatorTrigger(pi,runtime,ctx); await finishConsolidator(runtime);
 expect(pi.appendEntry).not.toHaveBeenCalled(); expect(runtime.consolidatorFailures).toBe(1);
});
it.each([1,3])('failure notice explains automatic retries at attempt %s and retains the batch',async(attempt)=>{
 const {runtime,branch,pi,ctx}=setup();
 runtime.consolidatorFailures=attempt-1;
 ctx.hasUI=true;ctx.ui={notify:vi.fn()};
 branch.push(observationsRecordedEntry('obs',{observations:[observation('one'),observation('two')],coversUpToId:'a'}));
 vi.mocked(spawnWorker).mockImplementationOnce(async opts=>{
  const request=readRequest(opts.env.OM_REQUEST_PATH!);
  writeFailure(runResultPath(opts.cwd,request.runId),request,'edit failed: oldText not found');
  return {...exit,code:1};
 });
 evaluateConsolidatorTrigger(pi,runtime,ctx);await finishConsolidator(runtime);
 expect(pi.appendEntry).not.toHaveBeenCalled();
 const notice=ctx.ui.notify.mock.calls.at(-1)[0];
 expect(notice).toContain(`Attempt ${attempt}/3`);
 expect(notice).toContain('Observations retained');
 expect(notice).toContain('/om:consolidate');
 expect(notice).toContain(attempt===3?'Automatic retry limit reached':'Automatic retry on a later turn after backoff');
 expect(notice).not.toContain('Error: edit failed');
});
it('confirmed consolidation does not drop observations arriving during the run',async()=>{
 const {runtime,branch,pi,ctx} = setup();
 branch.push(observationsRecordedEntry('obs',{observations:[observation('one'),observation('two')],coversUpToId:'a'}));
 const pending=gate(); vi.mocked(spawnWorker).mockReturnValue(pending.promise);
 evaluateConsolidatorTrigger(pi,runtime,ctx);
 const opts=vi.mocked(spawnWorker).mock.calls[0][0], request=readRequest(opts.env.OM_REQUEST_PATH!);
 branch.push(observationsRecordedEntry('new',{observations:[observation('new')],coversUpToId:'b'}));
 writeReceipt(runResultPath(opts.cwd,request.runId),request,{dispositions:request.ids.map(timestamp=>({timestamp,reason:'test noise'}))});
 pending.resolve(exit); await finishConsolidator(runtime);
 const drops=pi.appendEntry.mock.calls.find((c:any)=>c[0]===OM_OBSERVATIONS_DROPPED)[1].observationTimestamps;
 expect(drops).toEqual(request.ids); expect(drops).not.toContain('new');
});
it('no confirmed boundary means cancel compaction, not silently discard unobserved history',async()=>{
 const {runtime,ctx,branch} = setup(); let hook:any;
 registerCompactionHook({on:(_name:any,fn:any)=>hook=fn} as any,runtime);
 expect(await hook({preparation:{firstKeptEntryId:'b',tokensBefore:999},branchEntries:branch},ctx)).toEqual({cancel:true});
});
it('oversized input never launches or advances source coverage',async()=>{
 const {runtime,pi,ctx} = setup(); runtime.config.maxWorkerPromptBytes = 10;
 evaluateObserverTriggers(pi,runtime,ctx); await finishObservers(runtime);
 expect(spawnWorker).not.toHaveBeenCalled(); expect(pi.appendEntry).not.toHaveBeenCalled();
 expect(runtime.lastWorkerError).toContain('nothing was truncated');
 for (let i=0;i<5;i++) { runtime.observerRetryAt=0; evaluateObserverTriggers(pi,runtime,ctx); await finishObservers(runtime); }
 expect(runtime.observerFailures).toBe(0);
 expect(runtime.observerBlocked).toContain('maxWorkerPromptBytes');
 expect(spawnWorker).not.toHaveBeenCalled();
});
it('aborted consolidator releases its slot only after close, then permits a new dispatch',async()=>{
 const {runtime,branch,pi,ctx}=setup();
 branch.push(observationsRecordedEntry('obs',{observations:[observation('one'),observation('two')],coversUpToId:'a'}));
 const pending=gate(); vi.mocked(spawnWorker).mockReturnValueOnce(pending.promise);
 evaluateConsolidatorTrigger(pi,runtime,ctx);
 runtime.abortAllWorkers(); evaluateConsolidatorTrigger(pi,runtime,ctx,true);
 expect(spawnWorker).toHaveBeenCalledTimes(1); expect(runtime.consolidatorInFlight).toBe(true);
 pending.resolve(exit); await finishConsolidator(runtime);
 expect(pi.appendEntry).not.toHaveBeenCalled(); expect(runtime.consolidatorController).toBeUndefined();
 vi.mocked(spawnWorker).mockResolvedValueOnce({...exit,code:1});
 evaluateConsolidatorTrigger(pi,runtime,ctx,true); await finishConsolidator(runtime);
 expect(spawnWorker).toHaveBeenCalledTimes(2);
});
it('oversized consolidator input blocks without consuming transient retries',async()=>{
 const {runtime,branch,pi,ctx}=setup();
 branch.push(observationsRecordedEntry('obs',{observations:[observation('one'),observation('two')],coversUpToId:'a'}));
 runtime.config.maxWorkerPromptBytes=10;
 for(let n=0;n<5;n++){ evaluateConsolidatorTrigger(pi,runtime,ctx); await finishConsolidator(runtime); }
 expect(runtime.consolidatorBlocked).toContain('maxWorkerPromptBytes');
 expect(runtime.consolidatorFailures).toBe(0); expect(spawnWorker).not.toHaveBeenCalled();
 expect(pi.appendEntry).not.toHaveBeenCalled();
});
