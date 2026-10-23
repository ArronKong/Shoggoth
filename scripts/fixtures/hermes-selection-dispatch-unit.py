"""Offline contract tests for the hash-gated Hermes host proof (stdlib only)."""
import contextlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from tui_gateway import selection_dispatch as sd

OWNER = 'shoggoth_shared_capabilities'

class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='sgh-selection-unit-')
        self.home = self.temp.name
        self.env = dict(version=1, operation_id='op.unit', dispatch_ref='ref.unit',
            selection_digest='a' * 64, required_adapter_id=OWNER, adapter_generation='generation.unit')
        self.manager = SimpleNamespace(_selection_dispatch_gates={}, _plugins={OWNER:
            SimpleNamespace(enabled=True, error=None, module=object())})
        self.entry = dict(generation='generation.unit', plugin_id=OWNER, callback=self.accept_proof, finish=self.finish_proof, metadata=dict(instance_id='instance.unit',agent_id='hermes-default'))
        self.manager._selection_dispatch_gates[OWNER] = self.entry
        self.patches = [patch.object(sd, '_manager', lambda home: self.manager),
            patch('hermes_cli.plugins.load_config_readonly', lambda: {'plugins': {'entries': {OWNER: {'allow_selection_dispatch_gate': True}}}})]
        for p in self.patches: p.start()
        self.agent = SimpleNamespace(session_id='runtime.session', api_mode='chat_completions')

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def accept_proof(self, *, selection, identity):
        self.assertEqual(dict(identity), dict(runtime_session_id='runtime.session', task_id='task.unit', turn_id='turn.unit'))
        with self.assertRaises(TypeError): selection['dispatch_ref'] = 'tamper'
        return dict(dispatch_ref=selection['dispatch_ref'], selection_digest=selection['selection_digest'],
            adapter_generation=selection['adapter_generation'], context='Selected unit context')

    def finish_proof(self, *, selection, identity, outcome):
        self.assertIn(outcome, {'complete','stopped','failed'})
        return {key:selection[key] for key in ('dispatch_ref','selection_digest','adapter_generation')}

    def accepted(self):
        return sd.accept(self.home, 'ui.session', 'private prompt not persisted', self.env, owner_session_id='runtime.session')[0]

    def bind(self):
        self.accepted()
        return sd.before_model(self.agent, 'task.unit', 'turn.unit')

    def assert_code(self, code, fn):
        with self.assertRaises(sd.SelectionDispatchError) as c: fn()
        self.assertEqual(c.exception.code, code)

    def test_strict_envelope(self):
        self.assertEqual(sd.normalize(self.env), self.env)
        for change in [dict(version=True), dict(version=2), dict(selection_digest='A'*64), dict(operation_id='x'*129), dict(dispatch_ref='space ref')]:
            self.assert_code('SELECTION_INVALID', lambda change=change: sd.normalize({**self.env, **change}))
        self.assert_code('SELECTION_INVALID', lambda: sd.normalize({**self.env, 'dispatchRef':'camel'}))

    def test_trust_and_generation(self):
        self.assertEqual(sd.capabilities(self.home)['adapters'], [dict(required_adapter_id=OWNER, adapter_generation='generation.unit', instance_id='instance.unit', agent_id='hermes-default')])
        self.assert_code('SELECTION_ADAPTER_STALE', lambda: sd.accept(self.home, 'ui.session', 'p', {**self.env, 'adapter_generation':'old'}, owner_session_id='runtime.session'))
        with patch('hermes_cli.plugins.load_config_readonly', lambda: {'plugins': {'entries': {OWNER: {'allow_selection_dispatch_gate': False}}}}):
            self.assertEqual(sd.capabilities(self.home)['adapters'], [])
            self.assert_code('SELECTION_ADAPTER_UNAVAILABLE', self.accepted)

    def test_registration_host_owned_generation(self):
        context = SimpleNamespace(plugin_id=OWNER, _manager=SimpleNamespace(home_path=self.home, _selection_dispatch_gates={}))
        def track(_kind, key, mapping, entry, _previous): mapping[key]=entry; return SimpleNamespace()
        context._track_mapping_entry=track
        handle=sd.register_gate(context, lambda **kwargs: None, metadata=dict(instance_id='instance.unit',agent_id='hermes-default'), finish=self.finish_proof)
        entry=context._manager._selection_dispatch_gates[OWNER]
        self.assertRegex(entry['generation'], r'^[a-f0-9]{32}$')
        self.assertEqual(handle.selection_dispatch['adapter_generation'],entry['generation'])
        with self.assertRaises(TypeError): handle.selection_dispatch['adapter_generation']='tamper'
        self.assert_code('SELECTION_ADAPTER_DUPLICATE', lambda: sd.register_gate(context, lambda **kwargs: None, metadata=dict(instance_id='instance.unit',agent_id='hermes-default'), finish=self.finish_proof))
        with patch('hermes_cli.plugins.load_config_readonly', lambda: {}):
            other=SimpleNamespace(plugin_id='other', _manager=context._manager, _track_mapping_entry=track)
            self.assert_code('SELECTION_ADAPTER_UNTRUSTED', lambda: sd.register_gate(other, lambda **kwargs: None, metadata=dict(instance_id='instance.unit',agent_id='hermes-default'), finish=self.finish_proof))

    def test_idempotence_ownership_and_no_plaintext_prompt(self):
        receipt=self.accepted(); replay, repeated=sd.accept(self.home, 'ui.session', 'private prompt not persisted', self.env, owner_session_id='runtime.session')
        self.assertTrue(repeated);self.assertEqual(replay, receipt)
        self.assert_code('SELECTION_CONFLICT', lambda: sd.accept(self.home, 'ui.session', 'changed', self.env, owner_session_id='runtime.session'))
        self.assert_code('SELECTION_NOT_FOUND', lambda: sd.get(self.home, 'other.session', self.env['operation_id']))
        with sd._db(self.home) as db:
            row=dict(db.execute('SELECT * FROM selection_dispatches').fetchone())
            self.assertNotIn('private prompt', json.dumps(row))
        self.assertEqual((Path(self.home)/'selection-dispatches.sqlite').stat().st_mode & 0o777, 0o600)

    def test_exact_identity_before_provider(self):
        with sd.turn_scope(self.home, 'ui.session', self.env):
            self.assertEqual(self.bind(), 'Selected unit context')
            receipt=sd.get(self.home, 'ui.session', self.env['operation_id'])
            self.assertEqual((receipt['state'], receipt['actual_session_id'], receipt['actual_task_id'], receipt['actual_turn_id']), ('bound','runtime.session','task.unit','turn.unit'))
            sd.verify_request(self.agent, 'task.unit', 'turn.unit', {'messages':[{'content':'User text Selected unit context'}]})
            self.agent.session_id='different.runtime'
            self.assert_code('SELECTION_IDENTITY_CHANGED', lambda: sd.verify_request(self.agent, 'task.unit', 'turn.unit', {'messages':[]}))
            self.assertEqual(sd.get(self.home, 'ui.session', self.env['operation_id'])['state'], 'failed')

    def test_middleware_cannot_remove_selected_context(self):
        with sd.turn_scope(self.home, 'ui.session', self.env):
            self.bind()
            self.assert_code('SELECTION_CONTEXT_MISSING', lambda: sd.verify_request(self.agent,'task.unit','turn.unit',{'messages':[{'content':'stripped'}]}))
            self.assertEqual(sd.get(self.home, 'ui.session', self.env['operation_id'])['error_code'], 'SELECTION_CONTEXT_MISSING')

    def test_revoke_after_accept(self):
        with sd.turn_scope(self.home, 'ui.session', self.env):
            self.accepted();self.manager._selection_dispatch_gates.clear()
            self.assert_code('SELECTION_ADAPTER_UNAVAILABLE', lambda: sd.before_model(self.agent,'task.unit','turn.unit'))
            self.assertEqual(sd.get(self.home,'ui.session',self.env['operation_id'])['state'],'failed')

    def test_bad_proof_and_nonmodel_reference(self):
        for field,value in [('dispatch_ref','different'),('context','ref.unit'),('context',''),('context','   ')]:
            self.entry['callback']=lambda selection,identity,field=field,value=value: {**self.accept_proof(selection=selection,identity=identity),field:value}
            with sd.turn_scope(self.home,'ui.session',self.env):
                self.accepted();self.assert_code('SELECTION_PROOF_INVALID',lambda:sd.before_model(self.agent,'task.unit','turn.unit'))
            with sd._db(self.home) as db: db.execute('DELETE FROM selection_dispatches')

    def test_restart_never_remints_active(self):
        receipt=self.accepted()
        with patch.object(sd,'_PROCESS','new.process'):
            recovered=sd.get(self.home,'ui.session',self.env['operation_id'])
            self.assertEqual(recovered['dispatch_id'],receipt['dispatch_id']);self.assertEqual(recovered['state'],'interrupted')
            replay, repeated=sd.accept(self.home,'ui.session','private prompt not persisted',self.env, owner_session_id='runtime.session')
            self.assertTrue(repeated);self.assertEqual(replay['dispatch_id'],receipt['dispatch_id'])
        with sd._db(self.home) as db: db.execute('DELETE FROM selection_dispatches')
        with sd.turn_scope(self.home,'ui.session',self.env): self.bind()
        with patch.object(sd,'_PROCESS','new.process'):
            self.assertEqual(sd.get(self.home,'ui.session',self.env['operation_id'])['state'],'unknown')

    def test_pending_cancel_does_not_override_bound(self):
        self.accepted();sd.state(self.home,'ui.session',self.env,'queued')
        sd.cancel_pending(self.home,'ui.session',[self.env])
        self.assertEqual(sd.get(self.home,'ui.session',self.env['operation_id'])['state'],'cancelled')
        with sd._db(self.home) as db: db.execute('DELETE FROM selection_dispatches')
        with sd.turn_scope(self.home,'ui.session',self.env):
            self.bind();sd.cancel_pending(self.home,'ui.session',[self.env])
            self.assertEqual(sd.get(self.home,'ui.session',self.env['operation_id'])['state'],'bound')

    def test_physical_owner_resume_idempotence(self):
        original=self.accepted()
        with patch.object(sd,'_PROCESS','new.process'):
            found=sd.get(self.home,'new.ui.session',self.env['operation_id'],owner_session_id='runtime.session')
            self.assertEqual(found['dispatch_id'],original['dispatch_id']);self.assertEqual(found['state'],'interrupted')
            repeated,replayed=sd.accept(self.home,'new.ui.session','private prompt not persisted',self.env,owner_session_id='runtime.session')
            self.assertTrue(replayed);self.assertEqual(repeated['dispatch_id'],original['dispatch_id'])
            self.assert_code('SELECTION_NOT_FOUND',lambda:sd.get(self.home,'new.ui.session',self.env['operation_id'],owner_session_id='wrong.physical.session'))

    def test_exact_completion_and_unknown(self):
        with sd.turn_scope(self.home,'ui.session',self.env):
            self.bind();sd.finish_turn(self.agent,'complete')
            self.assertEqual(sd.get(self.home,'ui.session',self.env['operation_id'])['state'],'complete')
        with sd._db(self.home) as db: db.execute('DELETE FROM selection_dispatches')
        self.entry['finish']=lambda **kwargs: {'dispatch_ref':'wrong'}
        with sd.turn_scope(self.home,'ui.session',self.env):
            self.bind();self.assert_code('SELECTION_FINISH_UNCONFIRMED',lambda:sd.finish_turn(self.agent,'complete'))
            self.assertEqual(sd.get(self.home,'ui.session',self.env['operation_id'])['state'],'unknown')

    def test_core_tool_context_is_bound_immutable_and_worker_propagated(self):
        from tools.daemon_pool import DaemonThreadPoolExecutor
        with sd.turn_scope(self.home,'ui.session',self.env):
            self.bind()
            with DaemonThreadPoolExecutor(max_workers=1) as pool:
                context=pool.submit(sd.tool_context,self.agent,'task.unit','turn.unit').result(5)
            self.assertEqual(context['selection_dispatch'],self.env)
            self.assertEqual(context['selection_adapter_instance_id'],'instance.unit')
            with self.assertRaises(TypeError): context['selection_dispatch']['dispatch_ref']='tamper'
            sd.state(self.home,'ui.session',self.env,'cancelled')
            self.assert_code('SELECTION_TURN_NOT_BOUND',lambda:sd.tool_context(self.agent,'task.unit','turn.unit'))
        with sd.turn_scope(self.home,'ui.session',None):
            self.assertEqual(sd.tool_context(self.agent,'',''),{})

    def test_core_tool_context_rejects_owner_reload(self):
        with sd.turn_scope(self.home,'ui.session',self.env):
            self.bind()
            self.manager._selection_dispatch_gates[OWNER]={**self.entry,'metadata':{'instance_id':'changed','agent_id':'hermes-default'}}
            self.assert_code('SELECTION_ADAPTER_STALE',lambda:sd.tool_context(self.agent,'task.unit','turn.unit'))

    def test_event_sideband_owns_original_turn_and_terminal(self):
        self.accepted()
        notifications=[]
        def emit(name,sid): notifications.append((name,sd.event_sideband(sid)))
        with sd.event_scope(self.home,'ui.session',self.env,emit=emit):
            accepted=sd.event_sideband('ui.session')
            self.assertEqual(accepted['runtime_session_id'],'runtime.session')
            self.assertIsNone(accepted['actual_turn_id'])
            accepted['dispatch_ref']='tamper'
            self.assertEqual(sd.event_sideband('ui.session')['dispatch_ref'],self.env['dispatch_ref'])
            self.assertIsNone(sd.event_sideband('other.ui'))
            with sd.event_scope(self.home,'ui.session',None): self.assertIsNone(sd.event_sideband('ui.session'))
            with sd.turn_scope(self.home,'ui.session',self.env):
                sd.before_model(self.agent,'task.unit','turn.unit')
                self.assertEqual(notifications[0][0],'selection.dispatch.bound')
                self.assertEqual(notifications[0][1]['actual_turn_id'],'turn.unit')
                self.assertEqual(notifications[0][1]['state'],'bound')
                sd.finish_turn(self.agent,'complete')
            terminal=sd.event_sideband('ui.session')
            self.assertEqual(terminal['state'],'complete')
            self.assertEqual(terminal['actual_task_id'],'task.unit')
        self.assertIsNone(sd.event_sideband('ui.session'))

    def test_failed_gate_has_no_successful_finish_or_unknown_rewrite(self):
        self.entry['callback']=lambda **kwargs: (_ for _ in ()).throw(RuntimeError('gate rejected'))
        self.entry['finish']=lambda **kwargs: self.fail('unadmitted turn must not confirm a finish')
        with sd.turn_scope(self.home,'ui.session',self.env):
            self.accepted()
            self.assert_code('SELECTION_GATE_FAILED',lambda:sd.before_model(self.agent,'task.unit','turn.unit'))
            sd.finish_turn(self.agent,'failed')
            receipt=sd.get(self.home,'ui.session',self.env['operation_id'])
            self.assertEqual(receipt['state'],'failed')
            self.assertEqual(receipt['actual_turn_id'],'turn.unit')

    def test_selected_multipart_api_context_preserves_original_media(self):
        import ast
        from typing import Any, Optional
        payload=Path(__file__).resolve().parents[2]/'resources/external-plugin-host-patches/hermes/v1-c7c2df1/patched/agent/turn_context.py'
        function=next(node for node in ast.parse(payload.read_text()).body if isinstance(node,ast.FunctionDef) and node.name=='compose_user_api_content')
        namespace=dict(Any=Any,Optional=Optional,build_memory_context_block=lambda value:'memory:'+value)
        exec(compile(ast.Module(body=[function],type_ignores=[]),str(payload),'exec'),namespace)
        compose=namespace['compose_user_api_content']
        original=[{'type':'text','text':'original prompt'},{'type':'image_url','image_url':{'url':'data:image/png;base64,immutable'}}]
        snapshot=json.loads(json.dumps(original))
        self.assertIsNone(compose(original,'','ordinary plugin context',selection_multimodal=True))
        with sd.turn_scope(self.home,'ui.session',self.env):
            context=self.bind()
            self.assertIsNone(compose(original,'',context), 'multipart never enters the string-only durable sidecar')
            request=compose(original,'',context,selection_multimodal=True)
            self.assertEqual(request[:-1],original)
            self.assertEqual(request[-1],{'type':'text','text':context})
            self.assertEqual(original,snapshot)
            sd.verify_request(self.agent,'task.unit','turn.unit',{'messages':[{'role':'user','content':request}]})
            self.assert_code('SELECTION_CONTEXT_MISSING',lambda:compose(original,'','stripped',selection_multimodal=True))
            self.assert_code('SELECTION_CONTEXT_MISSING',lambda:sd.verify_request(self.agent,'task.unit','turn.unit',{'messages':[{'role':'user','content':request[:-1]}]}))

    def test_unsupported_runtime_and_ordinary_unchanged(self):
        with sd.turn_scope(self.home,'ui.session',self.env):
            self.accepted();self.assert_code('SELECTION_RUNTIME_UNSUPPORTED',lambda:sd.before_model(self.agent,'task.unit','turn.unit',unsupported_runtime=True))
        with sd.turn_scope(self.home,'ui.session',None):
            with patch.object(sd,'_gate',side_effect=AssertionError('ordinary gate called')):
                self.assertEqual(sd.before_model(self.agent,'',''),'')
                sd.verify_request(self.agent,'','',{})

if __name__ == '__main__': unittest.main()
