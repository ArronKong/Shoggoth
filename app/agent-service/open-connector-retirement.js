"use strict";
// The retired platform's opaque bytes remain recoverable. Never open its DBs or
// credential records, and never start a writer while recording this receipt.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readPrivateFile, atomicWritePrivateFile } = require("./private-file");
const { ensurePrivateDirectoryTree, assertPrivateDirectory, serviceError, lstatIfExists } = require("./security");
const DATA = ["access-v1.json", "external-selection-v1.sqlite", "external-selection-v1.sqlite-wal", "external-selection-v1.sqlite-shm", "runtime-version.json", "profile-revocations-v1.json", "runtime"];
function assertRetiredOpenConnectorStopped(paths) {
  const target = path.join(paths.connectorsDir || path.join(paths.stateDir, "connectors"), "runtime-child.json");
  if (!lstatIfExists(target)) return;
  let record; try { record = JSON.parse(readPrivateFile(target, { maxBytes: 2048 })); } catch { throw serviceError("CONNECTOR_WRITER_UNCONFIRMED", "Retired writer status is unknown"); }
  if (!record || Object.keys(record).sort().join(",") !== "nonce,pid,schemaVersion" || record.schemaVersion !== 1
    || !Number.isSafeInteger(record.pid) || record.pid <= 1 || !/^[a-f0-9]{64}$/u.test(record.nonce)) throw serviceError("CONNECTOR_WRITER_UNCONFIRMED", "Retired writer status is unknown");
  try { process.kill(record.pid, 0); } catch (error) { if (error?.code === "ESRCH") return; }
  throw serviceError("CONNECTOR_WRITER_UNCONFIRMED", "A retired OpenConnector writer may still be running");
}
function sameFile(before,after) { return ["dev","ino","size","mtimeMs","ctimeMs"].every(k=>before[k]===after[k]); }
function exact(value,keys) { return value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)); }
function validateReceipt(saved) {
  const bad=()=>{throw serviceError("MCP_RETIREMENT_RECEIPT_INVALID","OpenConnector retirement receipt is invalid");};
  if(!exact(saved,["schemaVersion","state","createdAt","legacyDataPreserved","credentialEntriesPreserved","files"])
    ||saved.schemaVersion!==1||saved.state!=="retired"||!Number.isSafeInteger(saved.createdAt)||saved.createdAt<0
    ||saved.legacyDataPreserved!==true||saved.credentialEntriesPreserved!==true||!Array.isArray(saved.files)||saved.files.length>10000)bad();
  const seen=new Set();
  for(const f of saved.files) {
    if(!exact(f,["path","bytes","sha256"])||typeof f.path!=="string"||!f.path.isWellFormed()||f.path.length>4096||f.path.includes("\\")||f.path.includes("\0")
      ||path.posix.isAbsolute(f.path)||f.path.split("/").some(p=>!p||p==="."||p==="..")||!DATA.includes(f.path.split("/")[0])
      ||f.path.includes("/")&&f.path.split("/")[0]!=="runtime"||seen.has(f.path)||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>1024**3
      ||typeof f.sha256!=="string"||!/^[a-f0-9]{64}$/u.test(f.sha256))bad();
    seen.add(f.path);
  }
  return saved;
}
function markOpenConnectorRetired(paths, { now = Date.now } = {}) {
  assertRetiredOpenConnectorStopped(paths);
  const root = path.resolve(paths.connectorsDir || path.join(paths.stateDir, "connectors"));
  const relative=path.relative(path.resolve(paths.trustedRoot),root);
  if(!relative||relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw serviceError("MCP_RETIREMENT_DATA_UNSAFE","Retired data root is unsafe");
  let ancestor=path.resolve(paths.trustedRoot);
  for(const part of ["",...relative.split(path.sep)]) {
    if(part)ancestor=path.join(ancestor,part);const stat=lstatIfExists(ancestor);
    if(!stat)break;
    if(!stat.isDirectory()||stat.isSymbolicLink()||typeof process.getuid==="function"&&stat.uid!==process.getuid())throw serviceError("MCP_RETIREMENT_DATA_UNSAFE","Retired data root is unsafe");
  }
  const receiptPath = path.join(root, "open-connector-retired-v1.json");
  if (lstatIfExists(receiptPath)) {
    try { return validateReceipt(JSON.parse(readPrivateFile(receiptPath,{maxBytes:2*1024*1024}).toString("utf8"))); }
    catch(error) { if(error?.code==="MCP_RETIREMENT_RECEIPT_INVALID")throw error;throw serviceError("MCP_RETIREMENT_RECEIPT_INVALID","OpenConnector retirement receipt is invalid"); }
  }
  const files=[];let totalBytes=0;
  const unsafe=()=>{throw serviceError("MCP_RETIREMENT_DATA_UNSAFE","Retired data changed or is not an ordinary owned file");};
  const walk=(absolute,relative)=>{
    const before=lstatIfExists(absolute);if(!before)return;
    if(before.isSymbolicLink()||!before.isDirectory()&&!before.isFile()||typeof process.getuid==="function"&&before.uid!==process.getuid())unsafe();
    if(before.isDirectory()) {
      const names=fs.readdirSync(absolute).sort();
      for(const name of names)walk(path.join(absolute,name),`${relative}/${name}`);
      const after=lstatIfExists(absolute);if(!after||!after.isDirectory()||!sameFile(before,after))unsafe();
      return;
    }
    if(before.nlink!==1||files.length>=10000||before.size>1024**3||(totalBytes+=before.size)>16*1024**3)unsafe();
    const hash=crypto.createHash("sha256"),fd=fs.openSync(absolute,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
    let readBytes=0;
    try {
      const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.nlink!==1||!sameFile(before,opened))unsafe();
      const buffer=Buffer.alloc(64*1024);
      for(;;){const n=fs.readSync(fd,buffer,0,buffer.length,null);if(!n)break;readBytes+=n;if(readBytes>before.size)unsafe();hash.update(buffer.subarray(0,n));}
      const after=fs.fstatSync(fd),pathAfter=lstatIfExists(absolute);
      if(readBytes!==before.size||!pathAfter||pathAfter.isSymbolicLink()||after.nlink!==1||pathAfter.nlink!==1||!sameFile(before,after)||!sameFile(before,pathAfter))unsafe();
    }finally{fs.closeSync(fd);}
    files.push({path:relative,bytes:readBytes,sha256:hash.digest("hex")});
  };
  for(const name of DATA)walk(path.join(root,name),name);
  if(lstatIfExists(root))assertPrivateDirectory(root);else ensurePrivateDirectoryTree(root,paths.trustedRoot);
  assertRetiredOpenConnectorStopped(paths);
  const receipt=validateReceipt({schemaVersion:1,state:"retired",createdAt:now(),legacyDataPreserved:true,credentialEntriesPreserved:true,files});
  atomicWritePrivateFile(receiptPath,`${JSON.stringify(receipt)}\n`,{trustedRoot:paths.trustedRoot});
  return receipt;
}
module.exports={markOpenConnectorRetired,assertRetiredOpenConnectorStopped,validateRetiredOpenConnectorReceipt:validateReceipt,RETIRED_OPEN_CONNECTOR_DATA:DATA};
