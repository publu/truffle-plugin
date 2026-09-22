import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {runtimeCommand,runRuntime} from '../plugins/truffle-plugin/scripts/runtimes.mjs';
import {hermesPython} from '../plugins/truffle-plugin/scripts/hermes-runtime.mjs';
const exec=promisify(execFile);
test('Hermes uses an explicit private session directory and a scoped host',()=>{
 const [command,args]=runtimeCommand('hermes',{mode:'work',stateDirectory:'/private/state'});
 assert.equal(command,process.execPath);assert.match(args[0],/hermes-runtime\.mjs$/);
 assert.deepEqual(args.slice(1),['--mode','work','--state','/private/state']);
 assert.ok(!args.includes('--yolo'));
});
test('Hermes tool dispatch enforces read/work permissions and blocks filesystem escapes',async()=>{
 await mkdir('.cache',{recursive:true});await exec('python3',['tests/hermes-tools.test.py'],{timeout:10000});
});
test('Hermes locates the explicit installed Python environment',async t=>{
 await mkdir('.cache',{recursive:true});const dir=resolve(await mkdtemp('.cache/hermes-python-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const python=join(dir,'python');await writeFile(python,'test',{mode:0o700});assert.equal(await hermesPython({HERMES_PYTHON:python,PATH:''}),python);
});
test('Hermes cancelled before startup does not execute a model',async()=>{
 await assert.rejects(runRuntime({runtime:'hermes',directory:process.cwd(),mode:'read',prompt:'Do not run',signal:AbortSignal.abort()}),/interrupted before starting/);
});
test('Hermes command subprocesses are terminated when the host is cancelled',async t=>{
 const {spawn}=await import('node:child_process');
 const {readFile}=await import('node:fs/promises');
 await mkdir('.cache',{recursive:true});const dir=resolve(await mkdtemp('.cache/hermes-cancel-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const host=resolve('plugins/truffle-plugin/scripts/hermes-host.py');
 const script=`import importlib.util,signal,sys\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location('host',sys.argv[1]); h=importlib.util.module_from_spec(spec); spec.loader.exec_module(h)\nsignal.signal(signal.SIGTERM,h.stop_commands)\np=h.ProjectTools(sys.argv[2],'work')\np.run('echo $$ > command.pid; exec sleep 30',60)\n`;
 const child=spawn('python3',['-c',script,host,dir],{stdio:'ignore'});
 const exited=new Promise(done=>child.once('close',done));
 t.after(()=>child.kill('SIGKILL'));
 let pid;
 for(let i=0;i<100&&!pid;i++){try{pid=Number(await readFile(join(dir,'command.pid'),'utf8'));}catch{}if(!pid)await new Promise(done=>setTimeout(done,20));}
 assert.ok(pid,'project command started');
 child.kill('SIGTERM');await exited;
 assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
