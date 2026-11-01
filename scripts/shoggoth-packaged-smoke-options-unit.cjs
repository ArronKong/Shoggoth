#!/usr/bin/env node
"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {parsePackagedSmokeOptions:parse}=require("./shoggoth-packaged-smoke-options.cjs");
const candidate={artifactRoot:"/private/tmp/isolated-candidate-dist"};
test("candidate guard and architecture mode are order-independent and never degrade to source-only",()=>{
 for(const mode of["--spike-arm64","--app-arm64","--zip-arm64","--spike-x64","--spike"]){const a=parse(["--require-candidate",mode],candidate),b=parse([mode,"--require-candidate"],candidate);assert.deepEqual(a,b);assert.equal(a.mode,mode);assert.equal(a.requireCandidate,true);assert.equal(a.requestedArch,mode.endsWith("x64")?"x64":mode.endsWith("arm64")?"arm64":null);}
 assert.throws(()=>parse(["--require-candidate"],candidate),{code:"PACKAGED_MODE_REQUIRED"});assert.equal(parse([]).mode,null);
});
test("all candidate modes require an explicit safe root and invalid/ambiguous flags fail before work",()=>{
 for(const args of[["--require-candidate","--spike-arm64"],["--app-arm64","--require-candidate"]])assert.throws(()=>parse(args),{code:"CANDIDATE_ARTIFACT_REQUIRED"});
 for(const args of[["--unknown"],["--spike-arm64","--app-arm64"],["--require-candidate","--require-candidate","--spike-arm64"],["--service-app"],["--service-app","relative.app"]])assert.throws(()=>parse(args,candidate),{code:"SMOKE_ARGUMENT_INVALID"});
 for(const artifactRoot of["relative", "bad\0path", "\n/private/tmp/candidate"])assert.throws(()=>parse(["--require-candidate","--spike-arm64"],{artifactRoot}),{code:"SMOKE_ARGUMENT_INVALID"});
});
test("direct App modes preserve exact absolute path with the guard in either position",()=>{
 for(const mode of["--service-app","--run-as-node-app"]){const result=parse(["--require-candidate",mode,"/private/tmp/candidate/Shoggoth.app"],candidate);assert.equal(result.mode,mode);assert.equal(result.appPath,"/private/tmp/candidate/Shoggoth.app");assert.deepEqual(parse([mode,"/private/tmp/candidate/Shoggoth.app","--require-candidate"],candidate),result);}
});
