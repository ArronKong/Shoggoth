import sys
sys.dont_write_bytecode=True
import ast,fcntl,importlib,importlib.util,json,os,pathlib,tempfile,types
REPO=pathlib.Path(__file__).resolve().parents[1]
assert (REPO/'app').is_dir(), 'Run the fixture from the Shoggoth source tree'
PINS=json.loads((REPO/'app/managed-hermes-runtime-pins.json').read_text())
PAYLOAD=REPO/'resources/external-plugin-host-patches'/PINS['hosts']['hermes']['payloadRelative']/'patched'
RUNTIME=pathlib.Path(os.environ.get('SHOGGOTH_TEST_HERMES_POLICY_RUNTIME',str(PAYLOAD))).resolve(strict=True)
for p in PAYLOAD.rglob('*.py'):ast.parse(p.read_text())
def load(name,p):
    if '.' in name:importlib.import_module(name.rpartition('.')[0])
    spec=importlib.util.spec_from_file_location(name,p);mod=importlib.util.module_from_spec(spec);sys.modules[name]=mod;spec.loader.exec_module(mod)
    if '.' in name:setattr(sys.modules[name.rpartition('.')[0]],name.rpartition('.')[2],mod)
    return mod
cases=[]
with tempfile.TemporaryDirectory(prefix='sgh-hermes-title-policy-',dir='/private/tmp') as tmp:
    root=pathlib.Path(tmp).resolve();root.chmod(0o700);data=root/'data';data.mkdir(mode=0o700);(data/'profiles').mkdir(mode=0o700)
    os.environ.update(HOME=str(root),HERMES_HOME=str(data))
    os.environ.pop('SHOGGOTH_HERMES_MANAGED_CONTROL_FILE',None)
    managed=load('shoggoth_managed_runtime',PAYLOAD/'shoggoth_managed_runtime.py')
    profiles=load('hermes_cli.profiles',PAYLOAD/'hermes_cli/profiles.py')
    title=load('agent.title_generator',PAYLOAD/'agent/title_generator.py')
    import yaml
    cfg={'model':{'default':'title-unit-no-network','provider':'custom'},'auxiliary':{'other':{'preserved':True},'title_generation':{'enabled':True,'model_upgrade_enabled':True,'provider':'custom'}},'plugins':{'enabled':[]}}
    config=data/'config.yaml';config.write_text(yaml.safe_dump(cfg));config.chmod(0o600)
    legacy=profiles.create_profile('legacy-fresh',no_alias=True,no_skills=True)
    assert 'title_generation' not in (yaml.safe_load((legacy/'config.yaml').read_text()) or {}).get('auxiliary',{}),'legacy fresh policy remains unchanged'
    os.environ['SHOGGOTH_HERMES_MANAGED_CONTROL_FILE']=str(data/'managed-control.json')
    assert managed.managed_title_model_allowed() is True,'ENV alone cannot change legacy semantics'
    calls=[]
    def call(**kw):
        calls.append(kw);return types.SimpleNamespace(choices=[types.SimpleNamespace(message=types.SimpleNamespace(content='{"title":"Review shared plugin design"}'))])
    title.call_llm=call
    assert title.generate_title('Review the shared plugin architecture')=='Review shared plugin design'
    assert len(calls)==1
    cases.append('legacy fresh creation and direct title model behavior unchanged; managed-looking ENV alone creates no gate authority')
    descriptor={'version':1,'backend_id':'hermes','runtime_root':str(RUNTIME),'runtime_tree_sha256':'a'*64,'data_root':str(data),'nonce':'b'*64,'control_token':'c'*64,'required_adapter_id':'shoggoth_shared_capabilities','adapter_tree_sha256':'d'*64}
    control=data/'managed-control.json';control.write_text(json.dumps(descriptor));control.chmod(0o600)
    state=managed._ManagedState(descriptor);fence=data/'shoggoth-managed-writer.fence'
    fd=os.open(fence,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    os.write(fd,json.dumps({'version':1,'data_root':str(data),'runtime_root':str(RUNTIME),'nonce':descriptor['nonce']}).encode());state.fence_fd=fd;managed._STATE=state
    try:
        # Actual fixed profile builder (not invented config or ids); capture the
        # publish point to verify policy is already fixed before rename.
        original_rename=profiles.os.rename;published=[]
        def rename(a,b):
            if pathlib.Path(b).parent==data/'profiles':
                parsed=yaml.safe_load((pathlib.Path(a)/'config.yaml').read_text());assert parsed['auxiliary']['title_generation']['enabled'] is False;assert parsed['auxiliary']['title_generation']['model_upgrade_enabled'] is False;published.append(str(b))
            return original_rename(a,b)
        profiles.os.rename=rename
        try:
            fresh=profiles.create_profile('managed-fresh',no_alias=True,no_skills=True)
            clone=profiles.create_profile('managed-clone',clone_from='default',clone_config=True,no_alias=True)
        finally:profiles.os.rename=original_rename
        assert len(published)==2
        for p in [fresh,clone]:
            parsed=yaml.safe_load((p/'config.yaml').read_text());assert parsed['model']['default']=='title-unit-no-network';assert (p.stat().st_mode&0o777)==0o700;assert ((p/'config.yaml').stat().st_mode&0o777)==0o600
        cloned=yaml.safe_load((clone/'config.yaml').read_text());assert cloned['auxiliary']['other']==cfg['auxiliary']['other'];assert cloned['auxiliary']['title_generation']['provider']=='custom';assert cloned['plugins']==cfg['plugins'];assert yaml.safe_load(config.read_text())==cfg
        cases.append('actual fresh and clone policy fixed before atomic publish; private modes and model/provider/other auxiliary/plugin settings preserved, default unchanged')
        # Reopening both config fields cannot re-enable either scheduling or
        # direct model entry in the actual managed state.
        assert title._model_title_upgrade_enabled() is False
        before=len(calls);assert title.generate_title('Review the shared plugin architecture') is None;assert len(calls)==before
        cases.append('actual managed state rejects direct title model and scheduled upgrade despite enabled=true config; zero new model calls')
        class DB:
            def __init__(self):self.rows={}
            def get_session_title_source(self,sid):return self.rows.get(sid,{}).get('source')
            def get_session_title(self,sid):return self.rows.get(sid,{}).get('title')
            def set_auto_title(self,sid,value,source=None):self.rows[sid]={'title':value,'source':source};return True
        db=DB();assert title.maybe_auto_title(db,'title-managed-unit','Review the shared plugin architecture',[]) is None;assert db.rows['title-managed-unit']['source']=='derived';assert len(calls)==before
        title.auto_title_session(db,'title-direct-unit','Review the shared plugin architecture');assert db.rows['title-direct-unit']['source']=='derived';assert len(calls)==before
        cases.append('real automatic title path retains instant derived title and direct daemon target derives fallback without spawning a title model')
        saved=managed._STATE;managed._STATE=object();assert managed.managed_title_model_allowed() is False
        assert title.generate_title('Review the shared plugin architecture') is None
        try:profiles.create_profile('bad-state',no_alias=True,no_skills=True);raise AssertionError('unknown state accepted')
        except managed.ManagedRuntimeError as error:assert error.code=='MANAGED_PROFILE_OWNER_UNKNOWN'
        assert not (data/'profiles/bad-state').exists();managed._STATE=saved
        cases.append('unknown managed state cannot enable title model or publish a new profile')
        other=root/'foreign';other.mkdir(mode=0o700)
        try:managed.protect_profile_title_policy(other,data/'profiles/foreign-profile');raise AssertionError('foreign stage accepted')
        except managed.ManagedRuntimeError as error:assert error.code=='MANAGED_PROFILE_STAGE_UNOWNED'
        target=data/'profiles/symlink-profile';stage=data/'profiles'/f'.symlink-profile.staging-{os.getpid()}';stage.mkdir(mode=0o700);(stage/'config.yaml').symlink_to(config)
        try:managed.protect_profile_title_policy(stage,target);raise AssertionError('symlink config accepted')
        except managed.ManagedRuntimeError as error:assert error.code=='MANAGED_PROFILE_CONFIG_UNSAFE'
        assert yaml.safe_load(config.read_text())==cfg
        cases.append('foreign staging and symlink config fail closed before changing outside/live config')
        os.rename(fence,data/'old-fence');fence.write_text('{}');fence.chmod(0o600)
        try:profiles.create_profile('changed-fence',no_alias=True,no_skills=True);raise AssertionError('changed fence accepted')
        except managed.ManagedRuntimeError as error:assert error.code=='MANAGED_WRITER_FENCE_CHANGED'
        assert not (data/'profiles/changed-fence').exists();assert title.generate_title('Review the shared plugin architecture') is None;assert len(calls)==before
        cases.append('changed writer fence prevents profile publication and cannot enable unavailable title model')
    finally:managed._STATE=None;os.close(fd)
print(json.dumps({'passed':True,'groups':len(cases),'cases':cases,'networkRequests':0,'realHostBootstrap':False,'scope':'Fixed source unit uses actual profile builder and title entrypoints with a unit-owned locked state. Genuine bootstrapped state/model/UI is a separate candidate acceptance.'},ensure_ascii=False))
