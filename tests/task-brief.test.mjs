import test from 'node:test';
import assert from 'node:assert/strict';
import { sharedOperation } from '../scripts/swarm-operations.mjs';
test('task creation preserves owner, brief, criteria and dependencies across the native CLI',async()=>{
 const options={id:'bounded',title:'Check retry',owner:'reviewer',request:'Inspect actual failed delivery',criteria:'["No duplicate send"]',intent:'review',dependencies:'build'};
 let body;
 await sharedOperation('task-create',options,async(path,value)=>{assert.equal(path,'/tasks');body=value;return value;});
 assert.equal(body.owner,'reviewer');assert.equal(body.request,options.request);assert.deepEqual(body.criteria,['No duplicate send']);assert.deepEqual(body.dependencies,['build']);assert.equal(body.intent,'review');
 await assert.rejects(sharedOperation('task-create',{...options,criteria:'not JSON'},()=>assert.fail('invalid criteria must not send')));
});
