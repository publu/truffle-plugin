import importlib.util
import json
import os
from pathlib import Path
import tempfile
import sys
sys.dont_write_bytecode = True
import unittest

spec = importlib.util.spec_from_file_location('hermes_host', Path(__file__).resolve().parents[1] / 'plugins/truffle-plugin/scripts/hermes-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

class ProjectPolicyTest(unittest.TestCase):
    def test_enforced_read_work_and_escape_paths(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[1] / '.cache') as temp:
            base = Path(temp); root = base/'project'; root.mkdir(); state = base/'state'; state.mkdir()
            readable=base/'peer-worktrees';readable.mkdir();(readable/'peer.txt').write_text('peer evidence')
            (root/'input.txt').write_text('value=42\n'); (base/'outside.txt').write_text('private')
            (root/'.env').write_text('private'); (root/'link').symlink_to(base, target_is_directory=True)
            read = host.ProjectTools(root, 'read', state)
            work = host.ProjectTools(root, 'work', state, readable)
            self.assertEqual(work.read(str(readable/'peer.txt')), 'peer evidence')
            self.addCleanup(os.close, work.readable.root_fd)
            empty_readable = host.ProjectTools(root, 'read', state, base/'not-created-yet')
            self.addCleanup(os.close, empty_readable.root_fd)
            self.assertEqual(empty_readable.read('input.txt'),'value=42\n')
            (base/'linked-peer-root').symlink_to(readable, target_is_directory=True)
            linked_readable = host.ProjectTools(root, 'read', state, base/'linked-peer-root')
            self.addCleanup(os.close, linked_readable.root_fd)
            self.assertIn('error',json.loads(linked_readable.dispatch('project_read', {'path':str(base/'linked-peer-root'/'peer.txt')})))
            self.assertIn('error',json.loads(work.dispatch('project_write',{'path':str(readable/'peer.txt'),'content':'bad'})))
            self.addCleanup(os.close, read.root_fd); self.addCleanup(os.close, work.root_fd)
            self.assertEqual(json.loads(read.dispatch('project_read', {'path':'input.txt'}))['text'], 'value=42\n')
            self.assertEqual(json.loads(read.dispatch('project_search', {'query':'value'}))['matches'][0]['line'], 1)
            for name,args in [('project_write',{'path':'input.txt','content':'bad'}),('project_patch',{'path':'input.txt','old':'42','new':'bad'}),('project_run',{'command':'touch escaped'}),('terminal',{'command':'touch escaped'}),('execute_code',{}),('delegate_task',{}),('tool_search',{})]:
                self.assertIn('error',json.loads(read.dispatch(name,args)))
            for path in ['../outside.txt',str(base/'outside.txt'),'link/outside.txt','.env','.git/config']:
                self.assertIn('error',json.loads(read.dispatch('project_read',{'path':path})))
                self.assertIn('error',json.loads(work.dispatch('project_write',{'path':path,'content':'bad'})))
            self.assertEqual((base/'outside.txt').read_text(),'private')
            self.assertEqual((root/'input.txt').read_text(),'value=42\n')
            self.assertIn('written',json.loads(work.dispatch('project_write',{'path':'new/answer.txt','content':'42'})))
            self.assertIn('written',json.loads(work.dispatch('project_patch',{'path':'new/answer.txt','old':'42','new':'43'})))
            self.assertEqual((root/'new/answer.txt').read_text(),'43')
            self.assertIn('error',json.loads(work.dispatch('project_patch',{'path':'new/answer.txt','old':'missing','new':'bad'})))
            self.assertEqual({t['function']['name'] for t in read.definitions()},{'project_read','project_search'})
            self.assertEqual({t['function']['name'] for t in work.definitions()},{'project_read','project_search','project_write','project_patch','project_run'})
            executed=json.loads(work.dispatch('project_run',{'command':'printf test-output'}))
            self.assertEqual(executed['exit_code'],0); self.assertEqual(executed['output'],'test-output')
            timeout=json.loads(work.dispatch('project_run',{'command':'sleep 10','timeout':0.2}))
            self.assertTrue(timeout['timed_out'])
            os.link(base/'outside.txt',root/'hardlink')
            self.assertIn('error',json.loads(work.dispatch('project_write',{'path':'hardlink','content':'bad'})))
            (root/'fifo').unlink(missing_ok=True); os.mkfifo(root/'fifo')
            self.assertIn('error',json.loads(read.dispatch('project_read',{'path':'fifo'})))

if __name__ == '__main__': unittest.main()
