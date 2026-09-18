import type {
  ModelChangeApplyResult,
  ModelChangeCapabilities,
  ModelChangePreview,
  ModelChangeSpec,
} from "../../types";

export type ModelEditorMode = "create" | "edit";
export type ModelEditorField = keyof ModelEditorValues;
export type ModelEditorPhase =
  | "idle"
  | "previewing"
  | "confirming"
  | "ready"
  | "applying"
  | "applied"
  | "partial"
  | "failed";

export interface ModelEditorValues {
  providerMode: "existing" | "new";
  providerKey: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  id: string;
  name: string;
  contextWindow: string;
  maxTokens: string;
  reasoning: boolean;
}

type ModelEditorBaseline = Omit<ModelEditorValues, "apiKey">;

export interface EditableModelInput {
  providerKey: string;
  baseUrl?: string;
  api?: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

export interface ModelEditorInitialInput {
  providers: Array<{ key: string }>;
  model?: EditableModelInput;
}

export interface ModelEditorState {
  mode: ModelEditorMode;
  capabilities: ModelChangeCapabilities;
  providerOptions: string[];
  providerLocked: boolean;
  idLocked: boolean;
  sourceModelId: string | null;
  values: ModelEditorValues;
  baseline: ModelEditorBaseline;
  phase: ModelEditorPhase;
  preview: ModelChangePreview | null;
  operationId: string | null;
  result: ModelChangeApplyResult | null;
}

export type ModelEditorAction =
  | { type: "field"; field: ModelEditorField; value: string | boolean }
  | { type: "preview-started" }
  | { type: "preview-ready"; preview: ModelChangePreview; confirmationRequired: boolean }
  | { type: "apply-started"; operationId: string }
  | { type: "apply-result"; result: ModelChangeApplyResult }
  | { type: "reset"; state: ModelEditorState };

const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// baseline 永远排除 API Key，既不进入 dirty diff，也不可能被日志序列化。
function baselineFromValues(values: ModelEditorValues): ModelEditorBaseline {
  const { apiKey: _secret, ...baseline } = values;
  return baseline;
}

// 创建态优先使用已有可写 Provider；没有时才渐进展开“新建 Provider”。
export function createInitialModelEditorState(
  mode: ModelEditorMode,
  input: ModelEditorInitialInput,
  capabilities: ModelChangeCapabilities,
): ModelEditorState {
  const providerOptions = input.providers.map((provider) => provider.key).filter(Boolean);
  const model = mode === "edit" ? input.model : undefined;
  const providerMode: "existing" | "new" = model || providerOptions.length > 0 ? "existing" : "new";
  const values: ModelEditorValues = {
    providerMode,
    providerKey: model?.providerKey || providerOptions[0] || "",
    baseUrl: model?.baseUrl || "",
    apiKey: "",
    api: model?.api || "",
    id: model?.id || "",
    name: model?.name || "",
    contextWindow: model?.contextWindow == null ? "" : String(model.contextWindow),
    maxTokens: model?.maxTokens == null ? "" : String(model.maxTokens),
    reasoning: model?.reasoning ?? false,
  };
  return {
    mode,
    capabilities,
    providerOptions,
    providerLocked: mode === "edit",
    idLocked: mode === "edit" && !capabilities.rename,
    sourceModelId: model?.id || null,
    values,
    baseline: baselineFromValues(values),
    phase: "idle",
    preview: null,
    operationId: null,
    result: null,
  };
}

// reducer 只维护确定性状态；任何 I/O 和 operationId 生成都留在组件边界。
export function modelEditorReducer(
  state: ModelEditorState,
  action: ModelEditorAction,
): ModelEditorState {
  switch (action.type) {
    case "field": {
      const nextValues = { ...state.values, [action.field]: action.value } as ModelEditorValues;
      if (action.field === "providerMode") {
        if (action.value === "new") {
          nextValues.providerKey = "";
          nextValues.baseUrl = "";
          nextValues.api = "";
        } else {
          nextValues.providerKey = state.providerOptions[0] || "";
          nextValues.baseUrl = "";
          nextValues.api = "";
        }
        nextValues.apiKey = "";
      }
      return {
        ...state,
        values: nextValues,
        phase: "idle",
        preview: null,
        operationId: null,
        result: null,
      };
    }
    case "preview-started":
      return { ...state, phase: "previewing", result: null };
    case "preview-ready":
      return {
        ...state,
        preview: action.preview,
        phase: action.confirmationRequired ? "confirming" : "ready",
        result: null,
      };
    case "apply-started":
      return { ...state, phase: "applying", operationId: action.operationId, result: null };
    case "apply-result":
      {
        // 后端细分状态折叠为 UI 的 applied/partial/failed 三态；结果对象仍保留
        // 原始状态用于可见明细。终态失败必须丢弃旧 operation，重试从新 preview 开始。
        const terminalFailure = action.result.status === "failed" || action.result.status === "compensated";
        const phase: ModelEditorPhase = action.result.status === "applied"
          ? "applied"
          : terminalFailure
            ? "failed"
            : "partial";
      return {
        ...state,
        operationId: terminalFailure ? null : (action.result.operationId || state.operationId),
        preview: terminalFailure ? null : state.preview,
        result: action.result,
        phase,
      };
      }
    case "reset":
      return action.state;
    default:
      return state;
  }
}

// dirty 比较采用完整非密钥字段；API Key 只以“当前是否输入”参与，不保留原值。
export function isModelEditorDirty(state: ModelEditorState): boolean {
  return state.values.apiKey.length > 0
    || JSON.stringify(baselineFromValues(state.values)) !== JSON.stringify(state.baseline);
}

function isPositiveIntegerText(value: string): boolean {
  if (!value.trim()) return true;
  const number = Number(value);
  return Number.isInteger(number) && number > 0;
}

// 与后端 normalizeModelChangeRequest 对齐，只返回稳定错误码；展示层负责按当前语言翻译。
export function validateModelEditor(state: ModelEditorState): Partial<Record<ModelEditorField, string>> {
  const errors: Partial<Record<ModelEditorField, string>> = {};
  const { values } = state;
  const fieldSupported = (field: string) => state.capabilities.fields?.[field] !== false;
  if (!values.providerKey.trim()) errors.providerKey = "provider_required";
  else if (!PROVIDER_RE.test(values.providerKey.trim())) errors.providerKey = "provider_invalid";
  if (!values.id.trim()) errors.id = "model_id_required";
  if (values.providerMode === "new") {
    try {
      const url = new URL(values.baseUrl);
      if (!url.hostname || !["http:", "https:"].includes(url.protocol)) throw new Error("invalid");
    } catch {
      errors.baseUrl = "base_url_invalid";
    }
  }
  if (fieldSupported("contextWindow") && !isPositiveIntegerText(values.contextWindow)) errors.contextWindow = "context_positive_integer";
  if (fieldSupported("maxTokens") && !isPositiveIntegerText(values.maxTokens)) errors.maxTokens = "max_tokens_positive_integer";
  return errors;
}

function optionalPositiveInteger(value: string): number | undefined {
  return value.trim() ? Number(value) : undefined;
}

// 只在提交边界裁剪字符串和解析数字，输入期间不破坏用户正在编辑的文本。
export function toModelChangeSpec(state: ModelEditorState): ModelChangeSpec {
  const { values } = state;
  // 后端显式声明不支持的字段既不展示，也不得进入请求摘要或 journal。
  const fieldSupported = (field: string) => state.capabilities.fields?.[field] !== false;
  return {
    providerKey: values.providerKey.trim(),
    providerMode: values.providerMode,
    ...(state.sourceModelId ? { sourceModelId: state.sourceModelId } : {}),
    ...(values.baseUrl.trim() ? { baseUrl: values.baseUrl.trim() } : {}),
    ...(values.apiKey ? { apiKey: values.apiKey } : {}),
    ...(values.api.trim() ? { api: values.api.trim() } : {}),
    model: {
      id: values.id.trim(),
      ...(fieldSupported("name") && values.name.trim() ? { name: values.name.trim() } : {}),
      ...(fieldSupported("contextWindow") && optionalPositiveInteger(values.contextWindow) !== undefined
        ? { contextWindow: optionalPositiveInteger(values.contextWindow) }
        : {}),
      ...(fieldSupported("maxTokens") && optionalPositiveInteger(values.maxTokens) !== undefined
        ? { maxTokens: optionalPositiveInteger(values.maxTokens) }
        : {}),
      ...(fieldSupported("reasoning") ? { reasoning: values.reasoning } : {}),
    },
  };
}
