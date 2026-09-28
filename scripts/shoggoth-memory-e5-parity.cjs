"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {E5Encoder}=require("../app/agent-service/e5-encoder");
(async()=>{
  const reference=JSON.parse(fs.readFileSync(path.resolve(__dirname,"../.artifacts/native-memory-e5-20260928/python-reference.json")));
  const encoder=new E5Encoder(),model=await encoder.open(),rows=[];
  try {
    for(const probe of reference.rows){
      const ids=encoder.tokenize(probe.text,probe.kind);
      assert.deepEqual(ids,probe.ids,`${probe.kind} tokenizer parity: ${probe.text}`);
      const vector=await encoder.encode(probe.text,probe.kind);
      const cosine=vector.reduce((sum,x,i)=>sum+x*probe.vector[i],0);
      rows.push({text:probe.text,kind:probe.kind,cosine});
      assert.ok(cosine>=.99,`cross-runtime vector cosine ${cosine}`);
    }
    const result={verified:true,model,pythonRuntime:reference.runtime,tokenizerProbes:rows.length,
      minimumCrossRuntimeCosine:Math.min(...rows.map(row=>row.cosine)),rows};
    fs.writeFileSync(path.resolve(__dirname,"../.artifacts/native-memory-e5-20260928/parity.json"),JSON.stringify(result,null,2)+"\n");
    console.log(JSON.stringify({...result,rows:undefined}));
  }finally{await encoder.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
