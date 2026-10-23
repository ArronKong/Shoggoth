"use strict";
const assert = require("node:assert/strict");
const { prepareHermesSelectedInput, captureHermesSelectionInput } = require("../app/core/hermes-selection-input");
const { HermesBackend } = require("../app/core/hermes-backend");
const capabilities = { version: 1, runtime_session_id: "actual-physical-owner", adapters: [{
  required_adapter_id: "shoggoth_shared_capabilities", adapter_generation: "actual-generation",
  instance_id: "actual-instance", agent_id: "hermes-fixture" }] };
const args = { runtimeId: "ui-session", agentId: "hermes-fixture", operationId: "selected-attachment-fixture",
  pluginSelection: [{ installationId: "fixture-installed-plugin", revision: 1 }], message: "original message",
  attachments: [{ type: "file", name: "fixture.txt", mimeType: "text/plain", content: Buffer.from("local attachment").toString("base64") }] };
const missing = () => Object.assign(new Error("not found"), { jsonRpc: true, code: 4096, contractCode: "SELECTION_NOT_FOUND" });
const receipt = captured => ({ version: 1, owner_session_id: capabilities.runtime_session_id, operation_id: args.operationId,
  input_digest: captured.inputDigest, message_digest: captured.messageDigest, attachment_digest: captured.attachmentDigest,
  attachments: captured.metadata, expires_at: Math.floor(Date.now()/1000)+900 });
function authority(input, state = "prepared") {
  const envelope = { version: 1, operationId: input.operationId, dispatchRef: "service-ref", selectionDigest: "a".repeat(64),
    requiredAdapterId: input.requiredAdapterId, adapterGeneration: input.adapterGeneration };
  return { envelope, receipt: { ...envelope, subject: input.subject, state, identity: state === "prepared" ? null
    : { ...input.subject, taskId: "actual-task", turnId: "actual-turn" }, createdAt: 0, updatedAt: 0, expiresAt: 9999999999999 } };
}
async function main() {
  const captured = captureHermesSelectionInput(args.message, args.attachments);
  let stages=0, mints=0, staged=null, previous=null, stageError=null, modern=false, getError=null;
  const requestHost = async (method, params) => {
    assert(!["image.attach_bytes","pdf.attach","file.attach","prompt.submit"].includes(method));
    if (method === "prompt.selection.capabilities") return { ...capabilities, ...(modern ? { selection_inputs: {
      version: 1, max_bytes: 26214400, max_items: 16, kinds: ["image","pdf","file"] } } : {}) };
    if (method === "prompt.selection.get") {
      if (getError) throw getError;
      if (previous === null) throw missing();
      return { selection_dispatch: previous };
    }
    if (method === "prompt.selection.input.get") {
      assert.equal(params.owner_session_id, capabilities.runtime_session_id);
      return { selection_input: staged };
    }
    assert.equal(method, "prompt.selection.input.stage"); stages++;
    if (stageError) { staged=receipt(captured); throw stageError; }
    staged=receipt(captured); return { selection_input: staged };
  };
  const input = { subject: { backendId:"hermes", instanceId:"actual-instance", agentId:args.agentId, sessionId:capabilities.runtime_session_id },
    operationId:args.operationId, requiredAdapterId:"shoggoth_shared_capabilities", adapterGeneration:"actual-generation", pluginSelection:args.pluginSelection };
  const service = { prepareExternalPluginSelection: async value => {
    if (!previous) mints++; assert.deepEqual(value,input); return authority(value, previous ? "completed" : "prepared");
  }, getExternalPluginSelection: async () => authority(input,"completed").receipt };
  await assert.rejects(prepareHermesSelectedInput({ ...args, requestHost, service }), { code: "PLUGIN_SELECTION_ATTACHMENTS_UNSUPPORTED" });
  assert.equal(stages,0);assert.equal(mints,0);
  modern=true;
  const selected=await prepareHermesSelectedInput({ ...args, requestHost, service });
  assert.equal(selected.inputDigest,captured.inputDigest);assert.equal(stages,1);assert.equal(mints,1);
  await prepareHermesSelectedInput({ ...args, requestHost, service });assert.equal(stages,1);
  await assert.rejects(prepareHermesSelectedInput({ ...args, message:"changed", requestHost, service }), { code:"PLUGIN_SELECTION_ATTACHMENTS_CONFLICT" });
  await assert.rejects(prepareHermesSelectedInput({ ...args, attachments:[], requestHost, service }), { code:"PLUGIN_SELECTION_ATTACHMENTS_CONFLICT" });
  previous={ ...selected.wire, dispatch_id:"host-dispatch", state:"complete", actual_session_id:capabilities.runtime_session_id,
    actual_task_id:"actual-task", actual_turn_id:"actual-turn",error_code:null };
  const before=mints;
  await assert.rejects(prepareHermesSelectedInput({ ...args, requestHost, service }), error => {
    assert.equal(error.code,"PLUGIN_SELECTION_NEEDS_VERIFICATION");assert.equal(error.originalOperation.run.status,"completed");return true;
  }); assert.equal(stages,1);assert.equal(mints,before);
  getError=new Error("unknown connection");
  await assert.rejects(prepareHermesSelectedInput({ ...args, requestHost, service }), { code:"PLUGIN_SELECTION_NEEDS_VERIFICATION",executionUncertain:true });assert.equal(stages,1);assert.equal(mints,before);
  getError=null;previous=null;staged=null;stageError=new Error("lost stage ACK");
  await assert.rejects(prepareHermesSelectedInput({ ...args, requestHost, service }), { code:"PLUGIN_SELECTION_NEEDS_VERIFICATION" });
  assert.equal(mints,before);assert.equal(stages,2);stageError=null;
  await prepareHermesSelectedInput({ ...args, requestHost, service });assert.equal(stages,2,"lost stage ACK must observe staged snapshot");
  staged=null;stageError=Object.assign(new Error("another caller already dispatched"),{jsonRpc:true,code:4096,contractCode:"SELECTION_INPUT_ALREADY_DISPATCHED"});
  const concurrentBefore=mints;
  await assert.rejects(prepareHermesSelectedInput({ ...args, requestHost, service }),{code:"PLUGIN_SELECTION_NEEDS_VERIFICATION",executionUncertain:true});
  assert.equal(mints,concurrentBefore);stageError=null;
  const unicode=captureHermesSelectionInput("中文 🌱",[{type:"file",name:"你好.txt",mimeType:"text/plain",content:Buffer.from("本地内容").toString("base64")}]);
  assert.equal(unicode.inputDigest,"5231c99e55c00be2ee5b58f1dca92af0de59dc879c04ebe2cc53cd458dad0cab");
  for (const attachment of [{...args.attachments[0],name:"../escape"},{...args.attachments[0],content:"bad!"}])
    assert.throws(()=>captureHermesSelectionInput(args.message,[attachment]),{code:"PLUGIN_SELECTION_ATTACHMENTS_INVALID"});
  const ordinary = new HermesBackend({ getConfig:()=>({hermesMode:"local",hermesRemotes:[]}) });
  let passed;ordinary._enqueueMessage=(_session,message,_key,_hooks,opts)=>{passed={message,opts};return Promise.resolve("ordinary-preserved");};
  assert.equal(await ordinary.sendMessage("agent:hermes-fixture:chat","ordinary","ordinary-key",{}, {attachments:args.attachments}),"ordinary-preserved");
  assert.deepEqual(passed.opts.attachments,args.attachments);await ordinary.stop();
  console.log(JSON.stringify({ok:true,groups:9,legacyUnsupportedNoMint:true,scopedStage:true,retryNoRestage:true,
    lostStageAckObservesSnapshot:true,existingObservationOnly:true,changedInputFailClosed:true,ordinaryUnchanged:true,localOnly:true}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
