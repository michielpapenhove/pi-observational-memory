import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import omWorker from '../agent/index.js';
import { makeRequest, readReceipt } from '../src/spawn/receipt.js';
import { runResultPath } from '../src/spawn/runs.js';
const dirs:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
function setup() {
 const root=mkdtempSync(join(tmpdir(),'om-worker-fix-'));dirs.push(root);
 const request=makeRequest('cons-test','consolidator','input',['a','b']);
 const requestPath=join(root,'request.json');writeFileSync(requestPath,JSON.stringify(request));
 for(const [k,v] of Object.entries({OM_WORKER:'consolidator',OM_RUN_ID:request.runId,OM_MEMORY_DIR:root,OM_REQUEST_PATH:requestPath,OM_RESULT_PATH:runResultPath(root,request.runId),OM_COST_PATH:join(root,'cost.json')}))vi.stubEnv(k,v);
 const tools=new Map<string,any>(),handlers=new Map<string,any[]>();
 const pi:any={registerTool:(t:any)=>tools.set(t.name,t),on:(name:string,h:any)=>handlers.set(name,[...handlers.get(name)??[],h])};
 const ctx={abort:vi.fn(),shutdown:vi.fn()};
 omWorker(pi);
 const emit=async(name:string,event:any)=>{for(const h of handlers.get(name)??[])await h(event,ctx);};
 const messages:any[]=[];
 const call=async(id:string,name:string,args:any)=>{
  let isError=false;try{await tools.get(name).execute(id,args);}catch{isError=true;}
  messages.push({role:'toolResult',toolCallId:id,toolName:name,isError});
  await emit('tool_execution_end',{toolCallId:id,toolName:name,isError});return isError;
 };
 const end=async(stopReason='stop')=>{messages.push({role:'assistant',stopReason});await emit('agent_end',{messages});};
 return {root,request,ctx,call,end};
}
it('the real worker factory accepts a corrected confirmation after an earlier rejected tool call',async()=>{
 const {root,request,ctx,call,end}=setup();
 expect(await call('first','complete_consolidation',{dispositions:[{timestamp:'a',reason:'noise'}]})).toBe(true);
 expect(ctx.abort).not.toHaveBeenCalled();
 expect(await call('repair','complete_consolidation',{dispositions:[{timestamp:'a',reason:'noise'},{timestamp:'b',reason:'noise'}]})).toBe(false);
 await end();
 expect(readReceipt(root,request).dispositions).toHaveLength(2);
});
it('the real worker factory permits an edit reread/repair and writes a valid receipt',async()=>{
 const {root,request,ctx,call,end}=setup();
 const content='---\nid: facts\ntitle: Facts\nsummary: Test facts\nupdated: today\n---\nAgreed direction: preserve the game; pickup counts immediately.\n';
 writeFileSync(join(root,'facts.md'),content);
 expect(await call('bad','edit',{path:'facts.md',oldText:'Agreed direction: pickup counts immediately.',newText:'Updated.'})).toBe(true);
 expect(ctx.abort).not.toHaveBeenCalled();
 expect(readFileSync(join(root,'facts.md'),'utf8')).toBe(content);
 expect(await call('reread','read',{path:'facts.md'})).toBe(false);
 expect(await call('repair','edit',{path:'facts.md',oldText:'pickup counts immediately',newText:'pickup stays immediate'})).toBe(false);
 expect(await call('done','complete_consolidation',{dispositions:[{timestamp:'a',path:'facts.md'},{timestamp:'b',reason:'noise'}]})).toBe(false);
 await end();
 expect(readReceipt(root,request).dispositions).toHaveLength(2);
 expect(ctx.abort).not.toHaveBeenCalled();
 expect(ctx.shutdown).toHaveBeenCalledOnce();
});
it('the real worker factory aborts on the fourth edit mismatch and records failure',async()=>{
 const {root,request,ctx,call,end}=setup();
 writeFileSync(join(root,'facts.md'),'original');
 for(let i=0;i<3;i++){
  expect(await call(`bad-${i}`,'edit',{path:'facts.md',oldText:'missing',newText:'x'})).toBe(true);
  expect(ctx.abort).not.toHaveBeenCalled();
 }
 expect(await call('fourth','edit',{path:'facts.md',oldText:'missing',newText:'x'})).toBe(true);
 expect(ctx.abort).toHaveBeenCalledOnce();
 await end();
 expect(()=>readReceipt(root,request)).toThrow('edit correction limit reached');
 expect(readFileSync(join(root,'facts.md'),'utf8')).toBe('original');
});
it('a normal model stop after a repairable edit error alone is not a completion',async()=>{
 const {root,request,call,end}=setup();
 writeFileSync(join(root,'facts.md'),'original');
 await call('bad','edit',{path:'facts.md',oldText:'missing',newText:'x'});
 await end();
 expect(()=>readReceipt(root,request)).toThrow('no accepted completion');
});
it.each(['error','aborted','length'])('a %s model end after edit recovery cannot produce a success receipt',async(stopReason)=>{
 const {root,request,call,end}=setup();
 writeFileSync(join(root,'facts.md'),'original');
 await call('bad','edit',{path:'facts.md',oldText:'missing',newText:'x'});
 await call('done','complete_consolidation',{dispositions:[{timestamp:'a',reason:'noise'},{timestamp:'b',reason:'noise'}]});
 await end(stopReason);
 expect(()=>readReceipt(root,request)).toThrow('model did not end cleanly');
});
it('the real worker factory aborts a fatal tool failure and records a failure instead of an ACK',async()=>{
 const {root,request,ctx,call,end}=setup();
 expect(await call('bad','write',{path:'../outside.md',content:'forbidden'})).toBe(true);
 expect(ctx.abort).toHaveBeenCalledOnce();
 await end();
 expect(()=>readReceipt(root,request)).toThrow('write failed');
});
it('exhausting correction attempts aborts without submitting success',async()=>{
 const {root,request,ctx,call,end}=setup();
 for(let i=0;i<4;i++)await call(`try-${i}`,'complete_consolidation',{dispositions:[]});
 expect(ctx.abort).toHaveBeenCalledOnce();await end();
 expect(()=>readReceipt(root,request)).toThrow('correction limit');
});
