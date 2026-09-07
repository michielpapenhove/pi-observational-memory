import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { registerConsolidatorTools } from '../agent/consolidator/tools.js';
import { registerObserverTool } from '../agent/observer/tool.js';
import { cleanWorkerEnd, makeRequest, readReceipt, validateDispositions, writeReceipt, writeFailure } from '../src/spawn/receipt.js';
import { runResultPath } from '../src/spawn/runs.js';

const dirs: string[] = [];
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
function fixture() {
 const root = mkdtempSync(join(tmpdir(),'om-receipt-')); dirs.push(root);
 const request = makeRequest('cons-test','consolidator','input',['a','b']);
 const tools = new Map<string,any>();
 const worker = registerConsolidatorTools({registerTool:(t:any)=>tools.set(t.name,t)} as any,root,request);
 const call = (name:string,p:any) => tools.get(name).execute('id',p);
 return {root,request,worker,call};
}
const topic = '---\nid: facts\ntitle: Facts\nsummary: User facts\nupdated: 2026-09-05\n---\nThe user has a dog.';
it('requires complete per-observation accounting and rechecks file hashes', async()=>{
 const {root,request,worker,call} = fixture();
 await call('write',{path:'facts.md',content:topic});
 expect(worker.result()).toBeUndefined();
 await call('complete_consolidation',{dispositions:[{timestamp:'a',path:'facts.md'},{timestamp:'b',reason:'Repeated routine status'}]});
 writeReceipt(runResultPath(root,request.runId),request,worker.result()!);
 expect(readReceipt(root,request).dispositions).toHaveLength(2);
 writeFileSync(join(root,'facts.md'),topic+' Changed');
 expect(()=>readReceipt(root,request)).toThrow('changed after completion');
});
it('rejects unknown, duplicated, missing, unfiled or implicit-discard observations',()=>{
 const {root} = fixture();
 for (const ack of [[],[{timestamp:'a',reason:'noise'}], [{timestamp:'a',reason:'noise'},{timestamp:'a',reason:'noise'}], [{timestamp:'a'},{timestamp:'b',reason:'noise'}], [{timestamp:'a',path:'missing.md'},{timestamp:'b',reason:'noise'}]]) {
  expect(()=>validateDispositions(root,['a','b'],ack)).toThrow();
 }
});
it('accepts already represented facts without requiring pointless rewrites',async()=>{
 const {root,worker,call} = fixture();
 writeFileSync(join(root,'facts.md'),topic);
 await call('complete_consolidation',{dispositions:[{timestamp:'a',path:'facts.md'},{timestamp:'b',path:'facts.md'}]});
 expect(worker.result()?.dispositions).toHaveLength(2);
});
it('a tool error prevents completion even if the model later claims success',async()=>{
 const {worker,call} = fixture();
 await expect(call('read',{path:'../bad.md'})).rejects.toThrow();
 await expect(call('complete_consolidation',{dispositions:[{timestamp:'a',reason:'noise'},{timestamp:'b',reason:'noise'}]})).rejects.toThrow('tool errors');
 expect(worker.result()).toBeUndefined();
});
it('mutations after completion invalidate the run',async()=>{
 const {worker,call} = fixture();
 await call('complete_consolidation',{dispositions:[{timestamp:'a',reason:'noise'},{timestamp:'b',reason:'noise'}]});
 await expect(call('write',{path:'facts.md',content:topic})).rejects.toThrow('completion already');
 expect(worker.result()).toBeUndefined();
});
it('validates run and input identity; absence is not success',()=>{
 const {root,request} = fixture();
 expect(()=>readReceipt(root,request)).toThrow();
 writeReceipt(runResultPath(root,request.runId),{...request,inputHash:'wrong'},{dispositions:[]});
 expect(()=>readReceipt(root,request)).toThrow('mismatched');
});
it('observer needs explicit finalization even for empty output',async()=>{
 let tool:any;
 const worker = registerObserverTool({registerTool:(t:any)=>tool=t} as any);
 expect(worker.result()).toBeUndefined();
 await tool.execute('id',{observations:[]});
 expect(worker.result()).toBeUndefined();
 await tool.execute('id',{observations:[],complete:true});
 expect(worker.result()).toEqual({observations:[]});
});
it('requires a normal final assistant stop with no prior model/tool failure',()=>{
 expect(cleanWorkerEnd({messages:[{role:'assistant',stopReason:'stop'}]})).toBe(true);
 for (const stopReason of ['error','aborted','length','toolUse']) expect(cleanWorkerEnd({messages:[{role:'assistant',stopReason}]})).toBe(false);
 expect(cleanWorkerEnd({messages:[{role:'toolResult',isError:true},{role:'assistant',stopReason:'stop'}]})).toBe(false);
 expect(cleanWorkerEnd({messages:[]})).toBe(false);
});
it('an incomplete confirmation names missing IDs and can be corrected in the same run',async()=>{
 const {root,request,worker,call} = fixture();
 await expect(call('complete_consolidation',{dispositions:[{timestamp:'a',reason:'noise'}]})).rejects.toThrow('Missing: b');
 expect(worker.result()).toBeUndefined();
 await call('complete_consolidation',{dispositions:[{timestamp:'a',reason:'noise'},{timestamp:'b',reason:'noise'}]});
 expect(worker.result()).toBeDefined();
 const event={messages:[{role:'toolResult',toolName:'complete_consolidation',toolCallId:'id',isError:true},{role:'assistant',stopReason:'stop'}]};
 expect(cleanWorkerEnd(event,worker.recoverableErrors)).toBe(true);
 writeReceipt(runResultPath(root,request.runId),request,worker.result()!);
 expect(readReceipt(root,request).dispositions).toHaveLength(2);
});
it('a recoverable confirmation error cannot pardon unrelated tool errors',()=>{
 const allowed=new Set(['correction']);
 for(const m of [
  {role:'toolResult',toolName:'complete_consolidation',toolCallId:'other',isError:true},
  {role:'toolResult',toolName:'write',toolCallId:'correction',isError:true},
  {role:'assistant',stopReason:'aborted'},
 ]) expect(cleanWorkerEnd({messages:[m,{role:'assistant',stopReason:'stop'}]},allowed)).toBe(false);
});
it('repeated invalid confirmations eventually fail instead of retrying forever',async()=>{
 const {worker,call}=fixture();
 for(let i=0;i<4;i++) await expect(call('complete_consolidation',{dispositions:[]})).rejects.toThrow();
 expect(worker.failure()).toContain('confirmation');
 expect(worker.result()).toBeUndefined();
});
it('reports a missing receipt without leaking a raw ENOENT',()=>{
 const {root,request}=fixture();
 expect(()=>readReceipt(root,request)).toThrow('without a valid completion');
});
it('a failure receipt explains the cause but can never authorize dropping observations',()=>{
 const {root,request}=fixture();
 writeFailure(runResultPath(root,request.runId),request,'Missing: b');
 expect(()=>readReceipt(root,request)).toThrow('Missing: b');
});
it('edit inserts replacement text literally, including dollar replacement patterns',async()=>{
 const {root,call} = fixture();
 await call('write',{path:'facts.md',content:'hello world'});
 await call('edit',{path:'facts.md',oldText:'world',newText:'$& $` $\''});
 expect(readFileSync(join(root,'facts.md'),'utf8')).toBe('hello $& $` $\'');
});
