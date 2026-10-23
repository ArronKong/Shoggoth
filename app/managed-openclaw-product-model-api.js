"use strict";
// Trusted Node composition only. No HTTP/renderer receives a lease or this API.
const { credentialOwner } = require("./managed-openclaw-provider-credential");
const { credentialPermit, credentialRpcOptions } = require("./managed-openclaw-provider-credential-schema");
const OP = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const fail = code => Object.assign(new Error(code), { code, status: 409 });
function createManagedOpenClawProductModelApi({ getClient, canAcquire, canContinue, begin, resumed, failed } = {}) {
  if ([getClient, canAcquire, canContinue, begin, resumed, failed].some(fn => typeof fn !== "function")) {
    throw new TypeError("Invalid managed model product composition");
  }
  const leases = new WeakMap(), flights = new Set();
  // Empty private owner brands bind Core holds to this exact Client and epoch.
  // Retirement fences effects but cannot prove a captured writer has exited.
  const owners = new WeakMap(), retiredOwners = new Set(), exitProofs = new WeakMap(), pendingExitProofs = new WeakMap();
  let currentOwner = null;
  function captureModelOwner() {
    const client = getClient();
    if (!client || !canContinue(client)) return null;
    if (!currentOwner || owners.get(currentOwner)?.client !== client || owners.get(currentOwner)?.epoch !== epoch) {
      currentOwner = Object.freeze(Object.create(null)); owners.set(currentOwner, { client, epoch, retired: false });
    }
    return currentOwner;
  }
  function isModelOwnerCurrent(owner) {
    const record = owner && owners.get(owner);
    try { return !!(record && record.retired === false && record.epoch === epoch
      && record.client === getClient() && canContinue(record.client) === true); }
    catch { return false; }
  }
  async function settleFlights() { while (flights.size) await Promise.allSettled([...flights]); }
  function knownAbsent(client) {
    const status = client?.getStatus?.();
    return status?.ownership === "absent" && ["absent", "closed", "stopped"].includes(status.state)
      && client.getEndpoint?.() === null && client.getExecution?.() === null;
  }
  let epoch = 0, activeScope = null, activeClient = null, activeAttempt = null, awaitingRecovery = false, activeTerminalOutcome = null, completedTerminal = null;
  const sameScope = (a, b) => a && b && a.operationId === b.operationId && a.requestDigest === b.requestDigest;
  const tracking = task => {
    flights.add(task); task.then(() => flights.delete(task), () => flights.delete(task)); return task;
  };
  function validateScope(scope) {
    if (!scope || typeof scope.operationId !== "string" || !OP.test(scope.operationId)
      || typeof scope.requestDigest !== "string" || !HASH.test(scope.requestDigest)) throw fail("MANAGED_HOST_MODEL_SCOPE_INVALID");
  }
  async function assertLease(lease, scope) {
    validateScope(scope);
    const record = leases.get(lease);
    if (!record || record.terminal || record.attempt !== activeAttempt || record.epoch !== epoch || record.client !== getClient()
      || !sameScope(record.scope, scope) || !canContinue(record.client)) throw fail("MANAGED_HOST_MODEL_LEASE_RETIRED");
    if (await record.api.assertModelLease(record.raw, scope) !== true) throw fail("MANAGED_HOST_MODEL_LEASE_INVALID");
    if (record.terminal || record.attempt !== activeAttempt || record.epoch !== epoch || record.client !== getClient()
      || !canContinue(record.client)) throw fail("MANAGED_HOST_MODEL_LEASE_RETIRED");
    return record;
  }
  async function reportFailure(client, scope, captured, attempt, error) {
    if (attempt !== activeAttempt || captured !== epoch || client !== activeClient || !sameScope(scope, activeScope) || !canContinue(client)) return;
    awaitingRecovery = true;
    try { await failed(client, error); } catch { /* preserve the original failure and withdrawn endpoint */ }
  }
  const canRecover = scope => {
    try { validateScope(scope); return !!(awaitingRecovery && getClient() === activeClient
      && sameScope(scope, activeScope) && flights.size === 0 && canContinue(activeClient)); }
    catch { return false; }
  };
  const canRecoverTerminal=scope=>{
    if(canRecover(scope)&&['applied','compensated','blocked'].includes(activeTerminalOutcome))return true;
    try{validateScope(scope);return !!(completedTerminal&&!activeScope&&flights.size===0&&sameScope(scope,completedTerminal.scope)
      &&completedTerminal.epoch===epoch&&completedTerminal.client===getClient()&&isModelOwnerCurrent(completedTerminal.ownerBrand)
      &&canContinue(completedTerminal.client));}catch{return false;}
  };
  const api = Object.freeze({
    // A trusted, read-only preflight distinguishes a foreign recovery from an
    // acquire whose acknowledgment was lost after the private pause began.
    canRecoverModelLease: scope => canRecover(scope),
    canRecoverCredentialTerminal: scope=>canRecoverTerminal(scope),
    recoverCredentialTerminal(scope) {
      if(!scope||Object.getPrototypeOf(scope)!==Object.prototype||Reflect.ownKeys(scope).length!==2
        ||!['operationId','requestDigest'].every(key=>Object.getOwnPropertyDescriptor(scope,key)?.value!==undefined))
        throw fail('MANAGED_HOST_MODEL_SCOPE_INVALID');
      validateScope(scope);const frozenScope=Object.freeze({operationId:scope.operationId,requestDigest:scope.requestDigest});
      if(!canRecoverTerminal(frozenScope))
        throw fail('MANAGED_HOST_MODEL_TERMINAL_RECOVERY_UNAVAILABLE');
      if(!activeScope){
        activeScope=completedTerminal.scope;activeClient=completedTerminal.client;activeAttempt=completedTerminal.attempt;
        activeTerminalOutcome=completedTerminal.outcome;awaitingRecovery=true;
      }
      const client=activeClient,captured=epoch,attempt=activeAttempt,outcome=activeTerminalOutcome,owner=currentOwner;
      if(!isModelOwnerCurrent(owner)||typeof client.modelApi?.recoverCredentialTerminal!=='function')
        throw fail('MANAGED_HOST_MODEL_TERMINAL_RECOVERY_UNAVAILABLE');
      const check=()=>{if(captured!==epoch||attempt!==activeAttempt||client!==getClient()||!sameScope(frozenScope,activeScope)
        ||!isModelOwnerCurrent(owner)||!canContinue(client))throw fail('MANAGED_HOST_MODEL_LEASE_RETIRED');};
      let withdrawal;try{withdrawal=begin(frozenScope);}catch(error){withdrawal=Promise.reject(error);}
      return tracking(Promise.resolve(withdrawal).then(async()=>{
        check();const result=await client.modelApi.recoverCredentialTerminal(frozenScope);check();
        if(!result||Object.getPrototypeOf(result)!==Object.prototype||Reflect.ownKeys(result).length!==4
          ||result.outcome!==outcome||result.paused!==false||result.resumed!==true||result.healthVerified!==true)
          throw fail('MANAGED_HOST_MODEL_RESUME_UNVERIFIED');
        await resumed(client);check();completedTerminal={scope:frozenScope,client,epoch:captured,attempt,outcome,ownerBrand:owner};activeScope=null;activeClient=null;activeAttempt=null;awaitingRecovery=false;activeTerminalOutcome=null;
        return Object.freeze({...result});
      }).catch(async error=>{await reportFailure(client,frozenScope,captured,attempt,error);throw error;}));
    },
    captureModelOwner,
    isModelOwnerCurrent,
    isOwnedExitProof: proof => !!(proof && exitProofs.has(proof)),
    matchesOwnedExitProof: (proof, owner) => !!(owner && exitProofs.get(proof)?.owners.has(owner)),
    async isModelApplySupported() {
      const client = getClient();
      if (!client || activeScope || flights.size || !canAcquire() || typeof client.modelApi?.isModelApplySupported !== "function") return false;
      const captured = epoch;
      return tracking(Promise.resolve().then(async () => {
        if (captured !== epoch || !canAcquire() || getClient() !== client) return false;
        return (await client.modelApi.isModelApplySupported()) === true && captured === epoch && !activeScope
          && flights.size === 1 && canAcquire() && getClient() === client;
      }));
    },
    assertModelLease: (lease, scope) => tracking(Promise.resolve().then(async () => { await assertLease(lease, scope); return true; })),
    acquireModelLease(scope) {
      validateScope(scope);
      const client = getClient(), modelApi = client?.modelApi;
      const recovery = scope.recovery === true && canRecover(scope);
      if(recovery&&activeTerminalOutcome)throw fail("MANAGED_HOST_MODEL_TERMINAL_RECOVERY_REQUIRED");
      if (!client || ((!canAcquire() || activeScope || flights.size) && !recovery) || !canContinue(client)
        || typeof modelApi?.acquireModelLease !== "function" || typeof modelApi.assertModelLease !== "function") {
        throw fail("MANAGED_HOST_MODEL_APPLY_UNAVAILABLE");
      }
      const ownerBrand = captureModelOwner();
      const captured = epoch;
      // Withdraw the public endpoint synchronously, before private pause awaits.
      activeScope = { operationId: scope.operationId, requestDigest: scope.requestDigest }; activeClient = client;
      const frozenScope = Object.freeze({ ...activeScope }); awaitingRecovery = false; activeTerminalOutcome = null; completedTerminal = null;
      const attempt = Symbol("model-lease-attempt"); activeAttempt = attempt;
      let withdrawal;
      try { withdrawal = begin(scope); } catch (error) { withdrawal = Promise.reject(error); }
      return tracking(Promise.resolve(withdrawal).then(async () => {
        if (captured !== epoch || !canContinue(client)) throw fail("MANAGED_HOST_MODEL_LEASE_RETIRED");
        const raw = await modelApi.acquireModelLease(scope);
        if (captured !== epoch || !canContinue(client)) throw fail("MANAGED_HOST_MODEL_LEASE_RETIRED");
        const names = ["modelRpc", "assertIdle", "renew", "restartPaused", "waitHealthy", "verifyTarget", "convergeAfterRetire", "finish", "abandon"];
        if (!raw || names.some(name => typeof raw[name] !== "function")
          || await modelApi.assertModelLease(raw, frozenScope) !== true) throw fail("MANAGED_HOST_MODEL_LEASE_INVALID");
        const record = { raw, client, api: modelApi, epoch: captured, attempt, scope: frozenScope, ownerBrand };
        const lease = { operationId: record.scope.operationId, requestDigest: record.scope.requestDigest };
        Object.defineProperties(lease, { token: { enumerable: true, get: () => raw.token }, expiresAt: { enumerable: true, get: () => raw.expiresAt } });
        for (const name of [...names, "getCredentialOwner", "bindCredentialPermit"]) {
          lease[name] = (...args) => {
            // Material never enters the public acquire/safeSpec. Capture this
            // private closed DTO before any async brand check or caller change.
            let capturedArgs = args;
            if (name === "bindCredentialPermit") {
              if (args.length !== 1) throw fail("MANAGED_HOST_MODEL_CREDENTIAL_INVALID");
              capturedArgs = [credentialPermit(args[0])];
              if (!sameScope(capturedArgs[0].scope, record.scope)) throw fail("MANAGED_HOST_MODEL_SCOPE_INVALID");
            } else if (name === "getCredentialOwner" && args.length !== 0) throw fail("MANAGED_HOST_MODEL_CREDENTIAL_INVALID");
            else if (name === "modelRpc" && args.length >= 3) {
              if (args.length !== 3) throw fail("MANAGED_HOST_MODEL_CREDENTIAL_INVALID");
              capturedArgs = args[2] === undefined ? [args[0], args[1]] : [args[0], args[1], credentialRpcOptions(args[0], args[2])];
            }
            return tracking(Promise.resolve().then(async () => {
            await assertLease(lease, record.scope);
            if (name === "getCredentialOwner" || name === "bindCredentialPermit") {
              if (!isModelOwnerCurrent(record.ownerBrand)) throw fail("MANAGED_HOST_MODEL_LEASE_RETIRED");
              if (typeof raw[name] !== "function") throw fail("MANAGED_HOST_MODEL_CREDENTIAL_UNSUPPORTED");
            }
            if (name === "finish") {
              const outcome = args[0];
              if (!sameScope(outcome, record.scope) || !["applied", "compensated", "blocked"].includes(outcome.outcome)) {
                throw fail("MANAGED_HOST_MODEL_SCOPE_INVALID");
              }
            }
            // Multiple callers may have awaited the same brand check. Claim the
            // terminal transition once immediately before invoking the raw effect.
            if (record.terminal) throw fail("MANAGED_HOST_MODEL_LEASE_RETIRED");
            if (name === "finish" || name === "abandon") record.terminal = true;
            if (name === "finish") activeTerminalOutcome = args[0].outcome;
            const result = await raw[name](...capturedArgs);
            if (name === "finish") {
              if (!result || Object.keys(result).length !== 3 || result.paused !== false
                || result.resumed !== true || result.healthVerified !== true) throw fail("MANAGED_HOST_MODEL_RESUME_UNVERIFIED");
              if (record.epoch !== epoch || !canContinue(record.client)) throw fail("MANAGED_HOST_MODEL_LEASE_RETIRED");
              await resumed(record.client);
              if (record.epoch !== epoch || !canContinue(record.client)) throw fail("MANAGED_HOST_MODEL_LEASE_RETIRED");
              completedTerminal={scope:record.scope,client:record.client,epoch:record.epoch,attempt:record.attempt,outcome:args[0].outcome,ownerBrand:record.ownerBrand};
              activeScope = null; activeClient = null; activeAttempt = null; awaitingRecovery = false; activeTerminalOutcome = null;
              return true;
            }
            if (name === "abandon") {
              if (!result || Object.keys(result).length !== 2 || result.paused !== true || result.resumed !== false) {
                throw fail("MANAGED_HOST_MODEL_PAUSE_UNVERIFIED");
              }
              await reportFailure(record.client, record.scope, captured, attempt, fail("MANAGED_HOST_MODEL_APPLY_UNCONFIRMED"));
              return true;
            }
            if (name === "getCredentialOwner" || name === "bindCredentialPermit") {
              if (record.terminal || record.attempt !== activeAttempt || !isModelOwnerCurrent(record.ownerBrand)) {
                throw fail("MANAGED_HOST_MODEL_LEASE_RETIRED");
              }
              if (name === "getCredentialOwner") {
                const owner = credentialOwner(result);
                if (!sameScope(owner, record.scope) || owner.expiresAt !== raw.expiresAt) throw fail("MANAGED_HOST_MODEL_CREDENTIAL_INVALID");
                return owner;
              }
              if (result !== true) throw fail("MANAGED_HOST_MODEL_CREDENTIAL_INVALID");
              return true;
            }
            return result;
          }).catch(async error => { await reportFailure(client, frozenScope, captured, attempt, error); throw error; }));
          };
        }
        leases.set(lease, record); return Object.freeze(lease);
      }).catch(async error => { await reportFailure(client, frozenScope, captured, attempt, error); throw error; }));
    },
  });
  return Object.freeze({ api,
    retire() {
      if (currentOwner) { owners.get(currentOwner).retired = true; retiredOwners.add(currentOwner); currentOwner = null; }
      epoch += 1; awaitingRecovery = false; activeScope = null; activeClient = null; activeAttempt = null; activeTerminalOutcome = null; completedTerminal = null;
    },
    settle: settleFlights,
    async proveOwnedExit(client) {
      await settleFlights();
      if (!knownAbsent(client) || flights.size !== 0) throw fail("MANAGED_HOST_OWNED_EXIT_UNVERIFIED");
      const previous = pendingExitProofs.get(client);
      const covered = new Set(previous ? exitProofs.get(previous).owners : []);
      for (const owner of retiredOwners) {
        const record = owners.get(owner);
        if (record?.client === client && record.retired && record.epoch < epoch) covered.add(owner);
      }
      const proof = Object.freeze(Object.create(null));
      exitProofs.set(proof, { client, owners: covered }); pendingExitProofs.set(client, proof);
      for (const owner of covered) retiredOwners.delete(owner);
      return proof;
    },
    acknowledgeOwnedExit(proof) {
      const record = exitProofs.get(proof);
      if (!record) throw fail("MANAGED_HOST_OWNED_EXIT_UNVERIFIED");
      if (pendingExitProofs.get(record.client) === proof) pendingExitProofs.delete(record.client);
    },
  });
}
module.exports = { createManagedOpenClawProductModelApi };
