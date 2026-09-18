// 模型身份只依赖 provider 与 id；JSON 元组避免冒号、斜杠等字符造成拼接碰撞。
export interface ModelIdentityInput {
  provider: string;
  id: string;
  name?: string;
}

// 配置模型只要求身份字段；使用结构类型避免纯函数依赖页面或 API 类型。
export interface ConfiguredModelIdentityInput {
  id: string;
  catalogId?: string;
}

export interface ConfiguredProviderIdentityInput {
  key: string;
  models: readonly ConfiguredModelIdentityInput[];
}

export interface ScopedDefaultModelInput {
  id: string;
  defaultModelScopes?: readonly string[];
}

// 为 React key、集合索引等场景生成跨 provider 稳定且唯一的模型身份。
export function modelIdentity(model: ModelIdentityInput): string {
  return JSON.stringify([model.provider, model.id]);
}

// A native Profile may intentionally leave defaultModel unset and inherit the
// runtime's advertised default. Defaults are scoped because two isolated Agent
// profiles can expose the same model id while selecting different defaults.
export function defaultModelForScope<T extends ScopedDefaultModelInput>(
  models: readonly T[],
  scope?: string,
): T | undefined {
  if (!scope) return undefined;
  const matches = models.filter((model) => model.defaultModelScopes?.includes(scope));
  return matches.length === 1 ? matches[0] : undefined;
}

// 按 provider + 模型 id 精确判断配置是否已存在，同时兼容配置 id 与目录 catalogId。
export function hasConfiguredModel(
  providers: readonly ConfiguredProviderIdentityInput[],
  providerKey: string,
  modelId: string,
): boolean {
  const provider = providers.find((item) => item.key === providerKey);
  return !!provider?.models.some(
    (model) => model.id === modelId || model.catalogId === modelId,
  );
}

// 判断目录模型是否对应某个 scope 的当前值，并在后端提供 provider 时严格消歧。
export function modelMatchesScope(
  model: ModelIdentityInput,
  scopeValue: string,
  scopeProvider?: string,
  catalog: readonly ModelIdentityInput[] = [],
): boolean {
  if (!scopeValue) return false;
  if (scopeProvider && scopeProvider !== model.provider) return false;

  const qualifiedRef = `${model.provider}/${model.id}`;
  // provider 已知时 id 已足够唯一，展示名可能在同一 provider 下重复，禁止参与匹配。
  if (scopeProvider) return scopeValue === model.id || scopeValue === qualifiedRef;
  // 带 provider 的引用本身无歧义，不依赖目录完整性即可精确匹配。
  if (scopeValue === qualifiedRef) return true;
  if (scopeValue !== model.id && scopeValue !== model.name) return false;
  if (catalog.length === 0) return true;

  // 旧后端只返回裸 id/name 时，跨 provider 歧义宁可不标记，也不能同时命中多个卡片。
  const matchedIdentities = new Set(
    catalog
      .filter((candidate) => scopeValue === candidate.id || scopeValue === candidate.name)
      .map(modelIdentity),
  );
  return matchedIdentities.size === 1 && matchedIdentities.has(modelIdentity(model));
}

// 删除前采用保守匹配：旧 API 未给 provider 时，裸 id/name 歧义也视为“可能在用”。
export function modelMayMatchScopeForDeletion(
  model: ModelIdentityInput,
  scopeValue: string,
  scopeProvider?: string,
): boolean {
  if (!scopeValue) return false;
  if (scopeProvider) return modelMatchesScope(model, scopeValue, scopeProvider);
  return (
    scopeValue === model.id ||
    scopeValue === model.name ||
    scopeValue === `${model.provider}/${model.id}`
  );
}

// 仅接受 URL 解析器认可、且含主机名的 HTTP(S) 绝对地址。
export function isValidHttpUrl(value: string): boolean {
  const candidate = value.trim();
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}
