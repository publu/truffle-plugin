import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runRuntime} from '../plugins/truffle-plugin/scripts/runtimes.mjs';

test('Kimi ACP resumes exact session, ignores replay, rejects write approval in read mode',async()=>{
 await mkdir('.cache',{recursive:true});const dir=resolve(await mkdtemp('.cache/kimi-acp-'));const oldPath=process.env.PATH;
 await writeFile(dir+'/kimi',`#!${process.execPath}
import {createInterface} from 'node:readline';
const send=x=>console.log(JSON.stringify({jsonrpc:'2.0',...x}));let prompt;
for await(const line of createInterface({input:process.stdin})){
 const e=JSON.parse(line);
 if(e.method==='initialize')send({id:e.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});
 if(e.method==='session/load'){
  if(e.params.sessionId!=='owned-kimi')process.exit(4);
  send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD REPLAY'}}}});
  send({id:e.id,result:{modes:{availableModes:[{id:'default'}]}}});
 }
 if(e.method==='session/set_mode')send({id:e.id,result:{}});
 if(e.method==='session/prompt'){
  prompt=e.id;
  send({id:99,method:'session/request_permission',params:{toolCall:{kind:'edit'},options:[{kind:'allow_once',optionId:'yes'},{kind:'reject_once',optionId:'no'}]}});
 }
 if(e.id===99){
  if(e.result.outcome.optionId!=='no')process.exit(5);
  send({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Current answer'}}}});
  send({id:prompt,result:{stopReason:'end_turn'}});
 }
}
`,{mode:0o700});
 process.env.PATH=dir+':'+oldPath;
 try {
  const r=await runRuntime({runtime:'kimi',session:'owned-kimi',directory:dir,mode:'read',prompt:'Test',signal:AbortSignal.timeout(5000)});
  assert.equal(r.text,'Current answer');assert.equal(r.session,'owned-kimi');
 } finally {process.env.PATH=oldPath;await rm(dir,{recursive:true,force:true});}
});

test('a turn keeps operator settings but not the Claude session that started the listener',async()=>{
 await mkdir('.cache',{recursive:true});const dir=resolve(await mkdtemp('.cache/turn-env-'));const old={...process.env};
 await writeFile(dir+'/codex',`#!${process.execPath}
for await(const c of process.stdin);
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:Object.keys(process.env).filter(k=>/^(CLAUDE|BOTSPACE_CONNECTOR)/.test(k)).sort().join(' ')}}));
`,{mode:0o700});
 for(const k of Object.keys(process.env))if(/^CLAUDE/.test(k))delete process.env[k];
 Object.assign(process.env,{PATH:dir+':'+old.PATH,CLAUDECODE:'1',CLAUDE_PID:'1',CLAUDE_EFFORT:'xhigh',CLAUDE_CODE_CHILD_SESSION:'1',CLAUDE_CODE_SESSION_ID:'s',CLAUDE_CODE_SESSION_ATTENDED:'1',CLAUDE_CODE_MESSAGING_SOCKET:'/gone',CLAUDE_CODE_MESSAGING_TOKEN:'t',CLAUDE_CODE_ENTRYPOINT:'cli',CLAUDE_CODE_EXECPATH:'/x',CLAUDE_CODE_USE_BEDROCK:'1',CLAUDE_CONFIG_DIR:'/c'});
 try {
  const r=await runRuntime({runtime:'codex',directory:dir,mode:'read',prompt:'Test',signal:AbortSignal.timeout(5000)});
  assert.equal(r.text,'BOTSPACE_CONNECTOR CLAUDE_CODE_USE_BEDROCK CLAUDE_CONFIG_DIR');
 } finally {for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);await rm(dir,{recursive:true,force:true});}
});
