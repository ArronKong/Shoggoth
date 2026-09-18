// 沉浸模式背景素材解析：agent 状态相位 → 媒体源（视频/图片）。
// 三级优先：用户自定义目录（static-server /__immersive 清单）> 内置默认 >
// 语义回退链（缺素材向近义状态回退，最终必落 idle）。素材加载失败由调用方
// 记入 blacklist 再来解析一次——同一条链自动跳过坏源。
//
// 相位枚举与两后端状态分析（见 plan §二）对齐：判据全部是「事件到没到」，
// 零后端特判——OpenClaw 不发 thinking/prompt 事件时对应相位自然不出现，
// 由回退链兜住退化，而不是代码分支。

export type ImmersivePhase =
  | "offline"
  | "starting"
  | "idle"
  | "waiting"
  | "thinking"
  | "tool"
  | "responding"
  | "error";

export interface BgMedia {
  url: string;
  type: "video" | "image";
}

// static-server listImmersiveBgManifest() 的返回形状（state → 文件项）。
export type BgManifest = Partial<Record<ImmersivePhase, { file: string; type: "video" | "image"; mtime?: number }>>;

// 内置默认（编译期常量，随 app 打包）：素材在 app/manage-ui/public/immersive/
// <state>.<ext>，在这里登记。当前 8 相全量登记——素材暂为 glass-bg.mp4 的改名
// 占位拷贝，换真素材 = 直接替换 public/immersive/ 下同名文件后重新打包。
// 用户侧免打包换片走 Shoggoth userData/immersive-bg/ 自定义目录，优先级更高。
const BUILTIN: Partial<Record<ImmersivePhase, BgMedia>> = {
  offline: { url: "/immersive/offline.mp4", type: "video" },
  starting: { url: "/immersive/starting.mp4", type: "video" },
  idle: { url: "/immersive/idle.mp4", type: "video" },
  waiting: { url: "/immersive/waiting.mp4", type: "video" },
  thinking: { url: "/immersive/thinking.mp4", type: "video" },
  tool: { url: "/immersive/tool.mp4", type: "video" },
  responding: { url: "/immersive/responding.mp4", type: "video" },
  error: { url: "/immersive/error.mp4", type: "video" },
};

// 语义回退链（不含自身；解析时前置自身）。
const FALLBACK: Record<ImmersivePhase, ImmersivePhase[]> = {
  idle: [],
  responding: ["idle"],
  tool: ["responding", "idle"],
  thinking: ["responding", "idle"],
  waiting: ["thinking", "responding", "idle"],
  starting: ["offline", "idle"],
  offline: ["idle"],
  error: ["idle"],
};

export async function fetchBgManifest(): Promise<BgManifest> {
  try {
    const r = await fetch("/__immersive/bg-manifest");
    if (!r.ok) return {};
    const j: unknown = await r.json();
    return j && typeof j === "object" ? (j as BgManifest) : {};
  } catch {
    // 旧 static-server 混跑新 UI（无此路由）→ 静默走内置
    return {};
  }
}

export function customBgUrl(file: string): string {
  return `/__immersive/bg/${encodeURIComponent(file)}`;
}

// 解析某相位当前应显示的媒体源。blacklist = 本会话加载失败过的 url。
export function resolveBgMedia(phase: ImmersivePhase, manifest: BgManifest, blacklist: ReadonlySet<string>): BgMedia {
  const chain: ImmersivePhase[] = [phase, ...FALLBACK[phase]];
  for (const p of chain) {
    const custom = manifest[p];
    if (custom && custom.file) {
      const url = customBgUrl(custom.file);
      if (!blacklist.has(url)) return { url, type: custom.type === "image" ? "image" : "video" };
    }
    const built = BUILTIN[p];
    if (built && !blacklist.has(built.url)) return built;
  }
  return { url: "/glass-bg.mp4", type: "video" };
}
