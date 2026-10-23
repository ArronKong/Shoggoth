'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const g=require('./hermes-managed-runtime-patch.cjs');
const {snapshotRuntimeTree,patchedTreeDigest,hashFile}=require('../app/managed-plugin-host-runtime');
const pins=require('../app/managed-hermes-runtime-pins.json');
const root=fs.mkdtempSync('/private/tmp/sgh-hermes-closure-unit-');fs.chmodSync(root,0o700);
let count=0;
function test(name,fn){fn();count++;}
function fails(fn,code){assert.throws(fn,e=>e.code===code);}
try{
 const owned=path.join(root,'owned');fs.mkdirSync(owned,{mode:0o700});
 const exe=path.join(owned,'python');fs.writeFileSync(exe,'owned fixture');
 const origin=path.join(owned,'hermes_cli.py');fs.writeFileSync(origin,'# fixture');
 const probe={executable:exe,prefix:owned,basePrefix:owned,paths:[owned,path.join(owned,'python311.zip')],hermesOrigin:origin,version:'3.11.15',architecture:'arm64',platform:'darwin',uvicorn:true};
 test('bounded owned probe',()=>g.assertClosure(owned,probe));
 test('foreign prefix',()=>fails(()=>g.assertClosure(owned,{...probe,basePrefix:root}),'HERMES_RUNTIME_NOT_SELF_CONTAINED'));
 test('foreign sys.path',()=>fails(()=>g.assertClosure(owned,{...probe,paths:[root]}),'HERMES_RUNTIME_NOT_SELF_CONTAINED'));
 test('wrong architecture',()=>fails(()=>g.assertClosure(owned,{...probe,architecture:'x64'}),'HERMES_RUNTIME_NOT_SELF_CONTAINED'));
 test('wrong version',()=>fails(()=>g.assertClosure(owned,{...probe,version:'3.14.0'}),'HERMES_RUNTIME_NOT_SELF_CONTAINED'));
 test('missing uvicorn',()=>fails(()=>g.assertClosure(owned,{...probe,uvicorn:false}),'HERMES_RUNTIME_NOT_SELF_CONTAINED'));
 const foreign=path.join(root,'foreign.py');fs.writeFileSync(foreign,'# outside');const link=path.join(owned,'foreign-link');fs.symlinkSync(foreign,link);
 test('lexically owned import symlink escape',()=>fails(()=>g.assertClosure(owned,{...probe,hermesOrigin:link}),'HERMES_RUNTIME_NOT_SELF_CONTAINED'));
 test('dependency symlink escape',()=>fails(()=>g.collect(owned),'HERMES_DEPENDENCY_LINK_ESCAPE'));fs.unlinkSync(link);
 const loose=path.join(owned,'unsafe');fs.writeFileSync(loose,'mutable input');fs.chmodSync(loose,0o666);
 test('world writable input rejection',()=>fails(()=>g.collect(owned),'HERMES_INPUT_WORLD_WRITABLE'));fs.unlinkSync(loose);
 for(const name of ['.lock','.DS_Store','cache.pyc','cache.pyo']){fs.writeFileSync(path.join(owned,name),'excluded');fs.chmodSync(path.join(owned,name),0o666);}fs.mkdirSync(path.join(owned,'__pycache__'));fs.writeFileSync(path.join(owned,'__pycache__/cache.pyc'),'excluded');
 test('explicit cache and lock exclusion',()=>assert.deepEqual(g.collect(owned).records.map(x=>x.path),['hermes_cli.py','python']));
 const native=path.join(root,'native');fs.mkdirSync(native,{mode:0o700});const rawInput=process.env.SHOGGOTH_TEST_HERMES_MANAGED_INPUT;
 assert(rawInput&&rawInput.startsWith('/private/tmp/sgh-hermes-managed-candidate-'),'Provide a previously frozen owned normalized input');
 const dylib=path.join(native,'libjpeg.dylib');fs.copyFileSync(path.join(rawInput,'venv/lib/python3.11/site-packages/PIL/.dylibs/libjpeg.62.4.0.dylib'),dylib);
 test('actual native owned closure',()=>assert.equal(g.auditNative(native,dylib).length,1));
 execFileSync('/usr/bin/install_name_tool',['-add_rpath','/outside-hermes-fixture/lib',dylib],{stdio:'ignore'});
 test('actual native external rpath rejection',()=>fails(()=>g.auditNative(native,dylib),'HERMES_NATIVE_RPATH_ESCAPE'));
 test('actual normalized input and notices pinned',()=>{const tree=snapshotRuntimeTree(rawInput);assert.equal(tree.sha256,pins.hosts.hermes.inputTreeSha256);assert.equal(hashFile(path.join(rawInput,'hermes-managed-dependency-notices.json')),pins.provenance.dependencyNoticesSha256);const notices=g.notices(rawInput);assert.equal(notices.distributions.length,116);assert.deepEqual(notices,JSON.parse(fs.readFileSync(path.join(rawInput,'hermes-managed-dependency-notices.json'))));});
 test('actual Python relocation and all native closure',()=>{g.assertClosure(rawInput,g.pythonProbe(path.join(rawInput,'venv/bin/python'),rawInput));assert.equal(g.auditNative(rawInput,path.join(rawInput,'venv/bin/python')).length,73);});
 test('hash anchored payload output',()=>{assert.equal(hashFile(path.join(g.PAYLOAD,'manifest.json')),pins.hosts.hermes.payloadManifestSha256);assert.equal(snapshotRuntimeTree(g.PAYLOAD).sha256,pins.hosts.hermes.payloadTreeSha256);assert.equal(patchedTreeDigest(snapshotRuntimeTree(rawInput),g.patchChanges(rawInput)),pins.hosts.hermes.outputTreeSha256);});
 console.log(JSON.stringify({status:'PASS',tests:count,nativeFiles:73,distributions:116,inputTreeSha256:pins.hosts.hermes.inputTreeSha256}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
