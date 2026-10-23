import sys
sys.dont_write_bytecode = True
import ast, fcntl, importlib, importlib.util, json, os, pathlib, shutil, tempfile
REPO=pathlib.Path(__file__).resolve().parents[1]
PAYLOAD=REPO/'resources/external-plugin-host-patches'/json.loads((REPO/'app/managed-hermes-runtime-pins.json').read_text())['hosts']['hermes']['payloadRelative']
RUNTIME=pathlib.Path(os.environ.get('SHOGGOTH_TEST_HERMES_POLICY_RUNTIME',str(PAYLOAD/'patched'))).resolve(strict=True)
ID='shoggoth_shared_capabilities'
for p in (PAYLOAD/'patched').rglob('*.py'):ast.parse(p.read_text())
cases=[]
def load(name,path):
    if '.' in name:importlib.import_module(name.rpartition('.')[0])
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module);return module

def mutable(p):
    if p.is_dir() and not p.is_symlink():
        p.chmod(0o700)
        for c in p.iterdir():mutable(c)

with tempfile.TemporaryDirectory(prefix='sgh-hermes-policy-unit-',dir='/private/tmp') as tmp:
    root=pathlib.Path(tmp).resolve();root.chmod(0o700)
    data=root/'data';data.mkdir(mode=0o700)
    hosthome=root/'home';hosthome.mkdir(mode=0o700)
    service=root/'service';service.mkdir(mode=0o700)
    (data/'profiles').mkdir(mode=0o700)
    (data/'plugins').mkdir(mode=0o700)
    (data/'skills').mkdir(mode=0o700)
    adapter=data/'plugins'/ID;adapter.mkdir(mode=0o700)
    for name in ['__init__.py','plugin.yaml','transport.py']:
        dest=adapter/name;dest.write_bytes((REPO/'resources/external-plugin-adapters/hermes'/name).read_bytes());dest.chmod(0o400)
    adapter.chmod(0o500)
    os.environ.update(HOME=str(hosthome),HERMES_HOME=str(data),SHOGGOTH_SERVICE_USER_DATA_ROOT=str(service),HERMES_BUNDLED_PLUGINS=str(data/'plugins'))
    os.environ.pop('SHOGGOTH_HERMES_MANAGED_CONTROL_FILE',None)
    managed=load('shoggoth_managed_runtime',PAYLOAD/'patched/shoggoth_managed_runtime.py')
    descriptor={'version':1,'backend_id':'hermes','runtime_root':str(RUNTIME),'runtime_tree_sha256':'a'*64,
                'data_root':str(data),'nonce':'b'*64,'control_token':'c'*64,'required_adapter_id':ID,
                'adapter_tree_sha256':managed._tree_digest(adapter)}
    control=data/'managed-control.json';control.write_text(json.dumps(descriptor));control.chmod(0o600)
    os.environ['SHOGGOTH_HERMES_MANAGED_CONTROL_FILE']=str(control)
    discovery=load('hermes_cli.plugins_discovery',PAYLOAD/'patched/hermes_cli/plugins_discovery.py')
    selection=load('tui_gateway.selection_dispatch',PAYLOAD/'patched/tui_gateway/selection_dispatch.py')
    from hermes_cli import profiles,plugins
    # These are real fixed CLI profile creation calls, not fabricated Agent ids.
    config={'model':{'default':'unit-only-no-model'},'plugins':{'enabled':[ID],'entries':{ID:{'allow_selection_dispatch_gate':True}}}}
    cfg=data/'config.yaml';cfg.write_text(json.dumps(config));cfg.chmod(0o600)
    fresh=profiles.create_profile('fresh-managed',no_alias=True,no_skills=True)
    clone=profiles.create_profile('clone-managed',clone_from='default',clone_config=True,no_alias=True)
    fresh_before=(fresh/'config.yaml').read_bytes();clone_before=(clone/'config.yaml').read_bytes()
    with plugins._plugin_home_scope(fresh):
        fresh_cfg=plugins.load_config_readonly() or {}
    assert (fresh_cfg.get('plugins') or {}).get('entries',{}).get(ID,{}).get('allow_selection_dispatch_gate') is not True
    with plugins._plugin_home_scope(clone):assert plugins.load_config_readonly()['plugins']['entries'][ID]['allow_selection_dispatch_gate'] is True
    cases.append('real fixed CLI fresh config lacks trust while cloned config retains operator entry; neither config is rewritten')
    # This is a unit-scope real locked fence/state object. It does NOT claim
    # bootstrap/immutable Host acceptance of the new source or execute a model.
    state=managed._ManagedState(descriptor)
    fence=data/'shoggoth-managed-writer.fence'
    fd=os.open(fence,os.O_RDWR|os.O_CREAT|os.O_EXCL,0o600);fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    os.write(fd,json.dumps({'version':1,'data_root':str(data),'runtime_root':str(RUNTIME),'nonce':descriptor['nonce']}).encode())
    state.fence_fd=fd;managed._STATE=state
    try:
        caps={str(home):selection.capabilities(str(home)) for home in [data,fresh,clone]}
        rows=[caps[str(home)]['adapters'][0] for home in [data,fresh,clone]]
        for row,home in zip(rows,[data,fresh,clone]):
            assert row['required_adapter_id']==ID
            expected='hermes-default' if home==data else 'hermes-'+home.name
            assert row['agent_id']==expected,(home,row)
        assert len({r['instance_id'] for r in rows})==3 and len({r['adapter_generation'] for r in rows})==3
        managers=[selection._manager(str(home)) for home in [data,fresh,clone]]
        assert len({id(m) for m in managers})==3
        assert (fresh/'config.yaml').read_bytes()==fresh_before and (clone/'config.yaml').read_bytes()==clone_before
        cases.append('actual PluginManager discovery/register/current gate gives default/fresh/clone distinct managers, canonical actual Agent ids, instances and generations')
        managed._STATE=None
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=adapter,home=fresh) is None
        assert selection.capabilities(str(fresh))['adapters']==[], 'ENV alone must not authorize fresh selection'
        manifest=managers[1]._plugins[ID].manifest
        with plugins._plugin_home_scope(fresh):assert discovery.gate_manifest(manifest,set(),None).action=='placeholder'
        with plugins._plugin_home_scope(data):assert discovery.gate_manifest(manifest,{ID},{ID}).action=='placeholder'
        managed._STATE=state
        cases.append('descriptor environment without bootstrapped state adds no authority; legacy opt-in and explicit disable semantics remain unchanged')
        managed._STATE=object()
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=adapter,home=fresh) is False
        managed._STATE=state
        cases.append('an arbitrary non-bootstrap state object cannot substitute for the real managed owner state')
        assert managed.managed_selection_adapter_authority(plugin_id='other_owner',manifest_path=adapter,home=fresh) is None
        other=root/'foreign';other.mkdir(mode=0o700)
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=adapter,home=other) is False
        fresh.chmod(0o755)
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=adapter,home=fresh) is False
        fresh.chmod(0o700)
        link=data/'profiles'/'alias-managed';link.symlink_to(fresh,target_is_directory=True)
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=adapter,home=link) is False
        link.unlink()
        cases.append('other owner cannot inherit authority; foreign, nonprivate and symlink Agent homes are rejected')
        (fresh/'plugins').mkdir(mode=0o700)
        fake=fresh/'plugins'/ID;fake.mkdir(mode=0o700)
        for name in ['__init__.py','plugin.yaml','transport.py']:
            dest=fake/name;dest.write_bytes((adapter/name).read_bytes());dest.chmod(0o400)
        fake.chmod(0o500)
        fakecfg=dict(fresh_cfg);fakecfg['plugins']=config['plugins'];(fresh/'config.yaml').write_text(json.dumps(fakecfg));(fresh/'config.yaml').chmod(0o600)
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=fake,home=fresh) is False
        with plugins._plugin_home_scope(fresh):plugins._ensure_plugins_discovered(force=True)
        assert selection.capabilities(str(fresh))['adapters']==[], 'same-id profile path with explicit allow must fail closed'
        mutable(fake);shutil.rmtree(fake);(fresh/'config.yaml').write_bytes(fresh_before)
        with plugins._plugin_home_scope(fresh):plugins._ensure_plugins_discovered(force=True)
        recovered=selection.capabilities(str(fresh))['adapters'][0]
        assert recovered['agent_id']=='hermes-fresh-managed' and recovered['adapter_generation']!=rows[1]['adapter_generation']
        assert selection.capabilities(str(clone))['adapters'][0]==rows[2]
        cases.append('same-id profile-local shadow is rejected even with allow=true; actual force discovery restores exact source with fresh generation and leaves other Agent receipt unchanged')
        source=adapter/'plugin.yaml';original=source.read_bytes();source.chmod(0o600);source.write_bytes(original+b'\n# mutation\n');source.chmod(0o400)
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=adapter,home=fresh) is False
        assert selection.capabilities(str(fresh))['adapters']==[]
        source.chmod(0o600);source.write_bytes(original);source.chmod(0o400)
        adapter.chmod(0o700);saved_source=source.read_bytes();source.unlink();source.symlink_to(adapter/'__init__.py')
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=adapter,home=fresh) is False
        source.unlink();source.write_bytes(saved_source);source.chmod(0o400);adapter.chmod(0o500)
        changed={**descriptor,'nonce':'d'*64};control.write_text(json.dumps(changed))
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=adapter,home=fresh) is False
        control.write_text(json.dumps(descriptor))
        cases.append('actual adapter byte/hash or descriptor identity drift withdraws current selection capability before any gate callback')
        saved=data/'old-fence';fence.rename(saved);fence.write_text(json.dumps({'version':1,'data_root':str(data),'runtime_root':str(RUNTIME),'nonce':descriptor['nonce']}));fence.chmod(0o600)
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=adapter,home=fresh) is False
        fence.unlink();saved.rename(fence)
        os.close(fd);state.fence_fd=None
        assert managed.managed_selection_adapter_authority(plugin_id=ID,manifest_path=adapter,home=fresh) is False
        cases.append('replaced writer fence and known closed writer cannot authorize a new profile dispatch')
        assert (fresh/'config.yaml').read_bytes()==fresh_before and (clone/'config.yaml').read_bytes()==clone_before
        print(json.dumps({'status':'PASS','groups':len(cases),'cases':cases,'hostStarts':0,'modelRequests':0,'serviceCalls':0,'remoteRequests':0,'globalWrites':0,
            'scope':'Fixed payload unit with actual fixed CLI/PluginManager and unit-owned locked state; not actual new-candidate bootstrap/Host acceptance'}))
    finally:
        if state.fence_fd is not None:os.close(state.fence_fd)
        managed._STATE=None
        plugins._reset_plugin_managers_for_tests()
        mutable(root)
