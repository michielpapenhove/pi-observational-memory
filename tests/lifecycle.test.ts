import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { spawnWorker } from '../src/spawn/launch.js';
import { StatusController } from '../src/ui/status-controller.js';
import { Runtime } from '../src/runtime.js';
import { registerCompactionTrigger } from '../src/hooks/compaction-trigger.js';
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
it('late compaction callbacks cannot resume or clear the newer session guard',()=>{
 const runtime=new Runtime();runtime.enabled=true;
 let handler:any, callbacks:any;
 const sendMessage=vi.fn();
 registerCompactionTrigger({on:(_n:any,h:any)=>handler=h,sendMessage} as any,runtime);
 handler({message:{stopReason:'toolUse'}},{hasUI:false,getContextUsage:()=>({tokens:999999}),compact:(c:any)=>callbacks=c});
 runtime.abortAllWorkers();runtime.compactInFlight=true;
 callbacks.onComplete(); callbacks.onError({message:'late failure'});
 expect(sendMessage).not.toHaveBeenCalled();expect(runtime.compactInFlight).toBe(true);
});
