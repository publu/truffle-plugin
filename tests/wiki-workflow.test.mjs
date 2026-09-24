import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWikiEntry, wikiWorkflow } from '../plugins/truffle-plugin/scripts/wiki-workflow.mjs';
import { handleJob, boundedContext } from '../plugins/truffle-plugin/scripts/connector.mjs';
const base='https://example.test/api/w/project';
const context=(ids, extra={})=>({capabilities:['wiki'],wiki:{pages:ids.map(id=>({id}))},...extra});
test('wiki entry reads one index, bounds text and keeps current revision provenance', async()=>{
 const calls=[];
 const entry=await loadWikiEntry(async path=>{calls.push(path);return {id:'project/index',title:'Project',revision:7,body:'x'.repeat(5000)};},context(['project/index','project/topic']),base);
 assert.deepEqual(calls,['/wiki/page?id=project%2Findex']);
 assert.equal(entry.body.length,4000);assert.equal(entry.bodyTruncated,true);assert.equal(entry.revision,7);
 assert.equal(entry.url,base+'/wiki/page?id=project%2Findex&revision=7');
 assert.equal(boundedContext({wikiEntry:entry}).wikiEntry.revision,7);
});
test('ambiguous, truncated and legacy listings do not guess another project index',async()=>{
 const api=()=>{throw Error('Unexpected request');};
 for(const ctx of [context(['one/index','two/index']),context(['one/index'],{truncated:true}),context([])]) {
  assert.match((await loadWikiEntry(api,ctx,base)).status,/Locate the current project/);
 }
 assert.equal(await loadWikiEntry(api,{},base),undefined);
 const entry=await loadWikiEntry(async()=>({id:'index',revision:1,body:'Project map'}),context(['one/index','index','two/index']),base);
 assert.equal(entry.id,'index');
});
test('missing or malformed index is explicit without a write, followup URL fetch, or fabricated content',async()=>{
 for(const response of [null,{id:'other/index',revision:1,body:'wrong'},{id:'index',body:'missing revision'}]) {
  const calls=[];const entry=await loadWikiEntry(async path=>{calls.push(path);return response;},context(['index']),base);
  assert.match(entry.status,/unavailable/);assert.equal(entry.body,undefined);assert.equal(calls.length,1);
 }
 const entry=await loadWikiEntry(async()=>{throw Error('SECRET failure');},context(['index']),base);
 assert.match(entry.status,/unavailable/);assert.ok(!JSON.stringify(entry).includes('SECRET'));
});
test('real connector path supplies wiki lifecycle and index before a turn, without automatic page writes',async()=>{
 const calls=[];let prompt;
 await handleJob({job:{status:'queued',event:{id:1,actor:'human-owner',objectId:'request'}},state:{sessions:{},turns:[],threadTurns:{}},persist:async()=>{},
  config:{name:'worker',runtime:'codex',directory:'/project',mode:'read',api:base,threadLimit:4},
  api:async(path,body)=>{calls.push([path,body]);if(path==='/threads/request')return {root:{id:'request',room:'general',author:'human-owner',body:'Review'},replies:[]};if(path==='/context')return context(['index']);if(path==='/wiki/page?id=index')return {id:'index',title:'Project',revision:3,body:'Read topics/current for the latest decision.'};return {};},
  run:async options=>{prompt=options.prompt;return {text:'Proposed topic update with evidence; no wiki edits made.'};}});
 assert.ok(prompt.includes(wikiWorkflow));assert.match(prompt,/Read topics\/current/);assert.match(prompt,/"revision":3/);
 assert.match(prompt,/read-only mode/);assert.match(prompt,/Mode: read/);
 assert.deepEqual(calls.filter(([path])=>path.startsWith('/wiki')).map(([path,body])=>[path,body]),[['/wiki/page?id=index',undefined]]);
});
