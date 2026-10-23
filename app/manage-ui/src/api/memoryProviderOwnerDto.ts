import type { MemoryProviderOwnerContext, MemoryProviderOwnerMutation, MemoryProviderOwnerReceipt, MemoryProviderOwnerScope } from '../types';

// Keep the wire shape and budgets aligned with memory-provider-owner-protocol.cjs.
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const publicCodes = new Set([
  'MEMORY_OWNER_INVALID', 'MEMORY_OWNER_CONFLICT', 'MEMORY_OWNER_FORBIDDEN', 'MEMORY_OWNER_RETIRED',
  'MEMORY_OWNER_CAPACITY', 'MEMORY_OWNER_RECOVERY_REQUIRED', 'MEMORY_OWNER_UNCERTAIN', 'MEMORY_OWNER_CLEANUP_PENDING',
  'MEMORY_OWNER_STORAGE_CHANGED', 'MEMORY_OWNER_STORAGE_UNSAFE', 'MEMORY_OWNER_CREDENTIAL_CHANGED', 'MEMORY_OWNER_RETIRE_FAILED',
]);
export class MemoryProviderOwnerResponseError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code = 'MEMORY_OWNER_INVALID', status = 0) {
    super('Memory provider account response could not be verified');
    this.name = 'MemoryProviderOwnerResponseError'; this.code = code; this.status = status;
    Object.freeze(this);
  }
}
function need(value: unknown): asserts value { if (!value) throw new MemoryProviderOwnerResponseError(); }
type Shape = Record<string, (value: unknown) => unknown>;
function record<S extends Shape>(value: unknown, shape: S, required: readonly string[] = Object.keys(shape)): { readonly [K in keyof S]: ReturnType<S[K]> } {
  need(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype);
  const keys = Reflect.ownKeys(value);
  need(keys.every(key => typeof key === 'string' && !forbidden.has(key) && Object.hasOwn(shape, key)) && required.every(key => Object.hasOwn(value, key)));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) if (Object.hasOwn(value, key)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    need(descriptor?.enumerable && Object.hasOwn(descriptor, 'value')); result[key] = shape[key](descriptor.value);
  }
  return Object.freeze(result) as { readonly [K in keyof S]: ReturnType<S[K]> };
}
function array<T>(value: unknown, validate: (item: unknown) => T, max: number): readonly T[] {
  need(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype && value.length <= max && Reflect.ownKeys(value).length === value.length + 1);
  return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    need(descriptor?.enumerable && Object.hasOwn(descriptor, 'value')); return validate(descriptor.value);
  }));
}
function id(value: unknown): string { need(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) && !forbidden.has(value)); return value; }
export function validateMemoryProviderOwnerProfileId(value: unknown): string { return id(value); }
function integer(value: unknown): number { need(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0); return value; }
function boolean(value: unknown): boolean { need(typeof value === 'boolean'); return value; }
const malformedUnicode = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
function text(value: unknown, max: number, nonempty = false): string {
  need(typeof value === 'string' && value.length <= max && !malformedUnicode.test(value) && !/[\u0000-\u001f\u007f]/u.test(value) && (!nonempty || value.trim().length > 0)); return value;
}
function choice<const T extends readonly string[]>(value: unknown, choices: T): T[number] { need(typeof value === 'string' && choices.includes(value)); return value as T[number]; }
function scope(value: unknown): MemoryProviderOwnerScope {
  const result = record(value, { kind: entry => choice(entry, ['global', 'profile']), profileId: id }, ['kind']);
  need(result.kind === 'global' ? !Object.hasOwn(result, 'profileId') : Object.hasOwn(result, 'profileId'));
  return result.kind === 'global' ? Object.freeze({ kind: 'global' }) : Object.freeze({ kind: 'profile', profileId: result.profileId });
}
function endpoint(value: unknown): string {
  const raw = text(value, 4096, true); need(raw === raw.trim() && !/\s/u.test(raw));
  let url: URL; try { url = new URL(raw); } catch { throw new MemoryProviderOwnerResponseError(); }
  need(['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password && !url.search && !url.hash);
  return url.href.replace(/\/$/u, '');
}
function provider(value: unknown): string { const result = id(value); need(!['none', 'auto', 'local', 'llama-cpp', 'shoggoth-e5'].includes(result)); return result; }
const api = (value: unknown) => choice(value, ['openai-completions', 'openai-responses', 'google-generative-ai']);
function budget(value: unknown, max = 65536, envelope = true): void {
  need(new TextEncoder().encode(JSON.stringify(envelope ? { id: 'i'.repeat(128), ok: true, result: value } : value)).length + (envelope ? 1 : 0) <= max);
}
export function validateMemoryProviderOwnerContext(value: unknown, profileId?: string): MemoryProviderOwnerContext {
  if (profileId !== undefined) id(profileId);
  const result = record(value, { catalogRevision: integer,
    owners: entry => array(entry, row => record(row, { ownerRef: id, label: item => text(item, 128, true), scope, providerId: provider, api,
      baseUrl: endpoint, revision: integer, status: item => choice(item, ['active', 'revoked']), hasCredential: boolean }), 128),
    pendingOperations: entry => array(entry, operation => record(operation, { operationId: id, ownerRef: id,
      phase: item => choice(item, ['reserved', 'credential_ready', 'published', 'retired']) }), 1024),
  });
  need(result.owners.every(row => row.scope.kind === 'global' || profileId !== undefined && row.scope.profileId === profileId));
  need(new Set(result.owners.map(row => row.ownerRef)).size === result.owners.length
    && new Set(result.pendingOperations.map(row => row.operationId)).size === result.pendingOperations.length);
  budget(result); return result;
}
export type MemoryProviderOwnerRecovery = { operationId: string; mode: 'resume' | 'cancel'; secret?: string };
export function validateMemoryProviderOwnerReceipt(value: unknown, request: Readonly<{ operationId: string; ownerRef?: string; secret?: string }>): MemoryProviderOwnerReceipt {
  const result = record(value, { operationId: id, ownerRef: id, catalogRevision: integer, ownerRevision: integer,
    status: entry => choice(entry, ['active', 'revoked', 'cancelled']), cleanupComplete: entry => { need(entry === true); return true as const; },
    phase: entry => choice(entry, ['completed', 'cancelled']), current: boolean,
  });
  need(result.phase === 'cancelled' ? result.status === 'cancelled' && result.current === false : result.status !== 'cancelled');
  need(result.operationId === request.operationId && (request.ownerRef === undefined || result.ownerRef === request.ownerRef));
  // Even an otherwise valid receipt must never echo the transient plaintext submitted by this call.
  need(request.secret === undefined || Object.entries(result).every(([key, entry]) => !key.includes(request.secret!)
    && (typeof entry !== 'string' || !entry.includes(request.secret!))));
  budget(result); return result;
}
const sensitiveName = /auth|cookie|token|api[-_]?key|password|secret|credential|signature|session|bearer|jwt/iu;
const sensitiveValue = /(?:^|\s)(?:bearer|basic|digest|token)\s+|(?:^|\b)(?:sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{12,})/iu;
const transportHeaders = new Set(['host', 'connection', 'proxy-connection', 'keep-alive', 'content-length', 'transfer-encoding', 'trailer', 'te', 'upgrade']);
function headers(value: unknown): Readonly<Record<string, string>> {
  need(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length <= 64);
  const result: Record<string, string> = {}, seen = new Set<string>();
  const names = Reflect.ownKeys(value); need(names.every(name => typeof name === 'string'));
  for (const name of (names as string[]).sort()) {
    need(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(name) && !forbidden.has(name) && !sensitiveName.test(name) && !transportHeaders.has(name.toLowerCase()) && !seen.has(name.toLowerCase()));
    const descriptor = Object.getOwnPropertyDescriptor(value, name); need(descriptor?.enumerable && Object.hasOwn(descriptor, 'value'));
    const entry = text(descriptor.value, 4096); need(!sensitiveValue.test(entry)); seen.add(name.toLowerCase()); result[name] = entry;
  }
  return Object.freeze(result);
}
function secret(value: unknown): string {
  need(typeof value === 'string' && value.length > 0 && !malformedUnicode.test(value) && !value.includes('\0') && new TextEncoder().encode(value).length <= 16384); return value;
}
export function validateMemoryProviderOwnerMutation(value: unknown): MemoryProviderOwnerMutation {
  const result = record(value, { action: entry => choice(entry, ['create', 'update', 'revoke']), operationId: id,
    expectedCatalogRevision: integer, ownerRef: id, expectedOwnerRevision: integer, scope, providerId: provider, api,
    label: entry => text(entry, 128, true), baseUrl: endpoint, headers,
    secretAction: entry => choice(entry, ['set', 'preserve', 'clear']), secret,
  }, ['action', 'operationId', 'expectedCatalogRevision']);
  if (result.action === 'create') {
    need(['scope', 'providerId', 'label', 'baseUrl', 'secretAction'].every(key => Object.hasOwn(result, key)) && !Object.hasOwn(result, 'ownerRef') && !Object.hasOwn(result, 'expectedOwnerRevision') && result.secretAction !== 'preserve');
    const builtins: Record<string, string> = { openai: 'openai-completions', voyage: 'openai-completions', mistral: 'openai-completions', ollama: 'openai-completions', gemini: 'google-generative-ai' };
    need(Object.hasOwn(builtins, result.providerId) ? !result.api || result.api === builtins[result.providerId] : ['openai-completions', 'openai-responses'].includes(result.api));
  } else {
    need(Object.hasOwn(result, 'ownerRef') && Object.hasOwn(result, 'expectedOwnerRevision') && !['scope', 'providerId', 'api'].some(key => Object.hasOwn(result, key)));
    need(result.action === 'update' ? ['label', 'baseUrl', 'secretAction'].every(key => Object.hasOwn(result, key)) : !['label', 'baseUrl', 'headers', 'secretAction', 'secret'].some(key => Object.hasOwn(result, key)));
  }
  need(result.secretAction === 'set' ? Object.hasOwn(result, 'secret') : !Object.hasOwn(result, 'secret'));
  budget(result, 32768, false); return result as MemoryProviderOwnerMutation;
}
export function validateMemoryProviderOwnerRecovery(value: unknown): MemoryProviderOwnerRecovery {
  return record(value, { operationId: id, mode: entry => choice(entry, ['resume', 'cancel']), secret }, ['operationId', 'mode']);
}
export async function fetchMemoryProviderOwnerDto<T>(url: string, validate: (value: unknown) => T, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, init); } catch { throw new MemoryProviderOwnerResponseError('MEMORY_OWNER_UNCERTAIN'); }
  let value: unknown;
  try {
    const raw = await response.text(); need(new TextEncoder().encode(raw).length <= 65536); value = JSON.parse(raw);
  } catch { throw new MemoryProviderOwnerResponseError('MEMORY_OWNER_INVALID', response.status); }
  if (!response.ok) {
    let code = 'MEMORY_OWNER_INVALID';
    try {
      const error = record(value, { code: entry => { need(typeof entry === 'string' && publicCodes.has(entry)); return entry; }, error: entry => text(entry, 256, true) });
      code = error.code;
    } catch { /* Discard every unknown field and any raw server message. */ }
    throw new MemoryProviderOwnerResponseError(code, response.status);
  }
  return validate(value);
}
