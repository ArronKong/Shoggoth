// Adapted from ybouane/liquidglass (MIT).
// Source revision, attribution and full terms: resources/legal/licenses/source/LIQUIDGLASS.txt
// Self-contained WebGL1 liquid-glass renderer. Ported from ybouane/liquidglass's
// pipeline (blit → cached Gaussian blur → glass composite), but the background is a
// scene <canvas> we draw ourselves (no html-to-image DOM rasterization). One GL canvas
// overlays the scene canvas and draws one or more refractive glass panels.

import { VS_QUAD, FS_BLIT, FS_BLUR, VS_GLASS, FS_GLASS } from "./shaders";

export interface GlassConfig {
  blurAmount: number;
  refraction: number;
  chromAberration: number;
  edgeHighlight: number;
  specular: number;
  fresnel: number;
  distortion: number;
  cornerRadius: number;
  zRadius: number;
  opacity: number;
  saturation: number;
  tintStrength: number;
  brightness: number;
  shadowOpacity: number;
  shadowSpread: number;
  shadowOffsetY: number;
  bevelMode: number;
}

export interface Panel {
  /** Centre X in CSS px (relative to the GL canvas). */
  cx: number;
  /** Centre Y in CSS px. */
  cy: number;
  /** Width in CSS px. */
  w: number;
  /** Height in CSS px. */
  h: number;
  /** 可选裁剪框（CSS px，视口坐标、左上原点）。面板（含阴影）只在框内绘制——用于滚动容器内的
   *  面板：DOM 文字被容器 overflow 裁掉时，玻璃也在同一边界截断（scissor test）。 */
  clip?: { x: number; y: number; w: number; h: number };
}

const BLUR_ITERATIONS = 6;
const SHADOW_PAD = 24;

interface FBO {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export class LiquidGlassGL {
  private canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private blitP!: WebGLProgram;
  private blurP!: WebGLProgram;
  private glassP!: WebGLProgram;
  private quadBuf!: WebGLBuffer; // full-screen [-1,1]
  private panelBuf!: WebGLBuffer; // [-0.5,0.5]
  private bgTex!: WebGLTexture;
  private blurA: FBO | null = null;
  private blurB: FBO | null = null;
  private uni: Record<string, Record<string, WebGLUniformLocation | null>> = {};
  private texW = 0;
  private bgReady = false;
  private blurKey = "";
  private initialized = false;
  private contextLost = false;
  private disposed = false;
  private sceneSource: HTMLCanvasElement | HTMLVideoElement | null = null;
  private onContextFailure?: () => void;

  constructor(canvas: HTMLCanvasElement, opts: { onContextFailure?: () => void } = {}) {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: false, alpha: true, antialias: false });
    if (!gl) throw new Error("WebGL not available");
    this.canvas = canvas;
    this.gl = gl;
    this.onContextFailure = opts.onContextFailure;
    this.initResources();
    canvas.addEventListener("webglcontextlost", this.handleContextLost);
    canvas.addEventListener("webglcontextrestored", this.handleContextRestored);
  }

  // 创建一套完整 GPU 资源；首次初始化与 context restored 共用，避免恢复后漏资源。
  private initResources(): void {
    const gl = this.gl;
    this.uni = {};
    this.blurA = null;
    this.blurB = null;
    this.texW = 0;
    this.bgReady = false;
    this.blurKey = "";
    this.blitP = this.link(VS_QUAD, FS_BLIT);
    this.blurP = this.link(VS_QUAD, FS_BLUR);
    this.glassP = this.link(VS_GLASS, FS_GLASS);
    this.uni.blit = this.locs(this.blitP, ["u_tex", "u_scale", "u_offset"]);
    this.uni.blur = this.locs(this.blurP, ["u_tex", "u_dir"]);
    this.uni.glass = this.locs(this.glassP, [
      "u_bgTex", "u_blurTex", "u_center", "u_size", "u_res", "u_radius", "u_pad",
      "u_refract", "u_chroma", "u_edgeHL", "u_spec", "u_fresnel", "u_distort",
      "u_alpha", "u_sat", "u_tint", "u_zRadius", "u_brightness",
      "u_shadowAlpha", "u_shadowSpread", "u_shadowOffY", "u_bevelMode",
    ]);

    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.panelBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.panelBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);

    this.bgTex = gl.createTexture()!;
    this.initialized = true;
  }

  // 浏览器只有在 preventDefault 后才会尝试恢复；丢失期间所有 GL 调用都短路。
  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.initialized = false;
    this.bgReady = false;
    this.blurA = null;
    this.blurB = null;
  };

  // 恢复后重建 shader/program/buffer/texture/FBO，并重新上传最后一帧场景。
  private handleContextRestored = (): void => {
    if (this.disposed) return;
    try {
      this.initResources();
      this.contextLost = false;
      if (this.sceneSource) this.uploadScene(this.sceneSource);
    } catch (error) {
      this.contextLost = true;
      this.initialized = false;
      console.error("[LiquidGlassGL] WebGL context restore failed:", error);
      this.onContextFailure?.();
    }
  };

  /** Upload a frame (canvas or video) as the background texture. Call every frame for
   *  live video; the blur cache is invalidated so it re-blurs against the new frame. */
  setScene(source: HTMLCanvasElement | HTMLVideoElement): void {
    this.sceneSource = source;
    if (this.contextLost || !this.initialized || this.disposed) return;
    this.uploadScene(source);
  }

  // 把场景上传到当前 context；恢复路径会用保存的 sceneSource 再调用一次。
  private uploadScene(source: HTMLCanvasElement | HTMLVideoElement): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.texW = (source as HTMLVideoElement).videoWidth || (source as HTMLCanvasElement).width;
    this.bgReady = false; // force a re-blur against the new frame
  }

  render(panels: Panel[], config: GlassConfig, dpr: number): void {
    if (this.contextLost || !this.initialized || this.disposed) return;
    const gl = this.gl;
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    if (W === 0 || H === 0) return;
    if (this.texW === 0 || panels.length === 0) {
      // canvas 是位图：0 面板 / 纹理未就绪的帧若直接 return，上一帧画的玻璃会永久
      // 残留（沉浸模式切「今日动态」后聊天气泡鬼影盖在列表上，实测踩过）——
      // 与正常路径同款透明清屏后再退。
      const gl0 = this.gl;
      gl0.bindFramebuffer(gl0.FRAMEBUFFER, null);
      gl0.viewport(0, 0, W, H);
      gl0.clearColor(0, 0, 0, 0);
      gl0.clear(gl0.COLOR_BUFFER_BIT);
      return;
    }

    this.ensureFBOs(W, H);
    const blurA = this.blurA!;
    const blurB = this.blurB!;

    // ── Prepare the background (sharp copy + cached blur) — only when scene/blur change ──
    const key = `${config.blurAmount}`;
    if (!this.bgReady || key !== this.blurKey) {
      // copy bgTex → blurA
      gl.useProgram(this.blitP);
      gl.bindFramebuffer(gl.FRAMEBUFFER, blurA.fbo);
      gl.viewport(0, 0, blurA.w, blurA.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
      gl.uniform1i(this.uni.blit.u_tex, 0);
      gl.uniform2f(this.uni.blit.u_scale, 1, 1);
      gl.uniform2f(this.uni.blit.u_offset, 0, 0);
      this.drawQuad(this.blitP, this.quadBuf);

      if (config.blurAmount > 0) {
        const spread = config.blurAmount * 2.5;
        gl.useProgram(this.blurP);
        gl.uniform1i(this.uni.blur.u_tex, 0);
        for (let i = 0; i < BLUR_ITERATIONS; i++) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, blurB.fbo);
          gl.viewport(0, 0, blurB.w, blurB.h);
          gl.bindTexture(gl.TEXTURE_2D, blurA.tex);
          gl.uniform2f(this.uni.blur.u_dir, spread / blurA.w, 0);
          this.drawQuad(this.blurP, this.quadBuf);

          gl.bindFramebuffer(gl.FRAMEBUFFER, blurA.fbo);
          gl.bindTexture(gl.TEXTURE_2D, blurB.tex);
          gl.uniform2f(this.uni.blur.u_dir, 0, spread / blurB.h);
          this.drawQuad(this.blurP, this.quadBuf);
        }
      }
      this.bgReady = true;
      this.blurKey = key;
    }

    // ── Glass composite to the screen ──
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.glassP);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.uniform1i(this.uni.glass.u_bgTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, blurA.tex);
    gl.uniform1i(this.uni.glass.u_blurTex, 1);

    const u = this.uni.glass;
    gl.uniform2f(u.u_res, W, H);
    gl.uniform1f(u.u_radius, config.cornerRadius * dpr);
    gl.uniform1f(u.u_pad, SHADOW_PAD * dpr);
    gl.uniform1f(u.u_refract, config.refraction);
    gl.uniform1f(u.u_chroma, config.chromAberration);
    gl.uniform1f(u.u_edgeHL, config.edgeHighlight);
    gl.uniform1f(u.u_spec, config.specular);
    gl.uniform1f(u.u_fresnel, config.fresnel);
    gl.uniform1f(u.u_distort, config.distortion);
    gl.uniform1f(u.u_alpha, config.opacity);
    gl.uniform1f(u.u_sat, config.saturation);
    gl.uniform1f(u.u_tint, config.tintStrength);
    gl.uniform1f(u.u_zRadius, config.zRadius * dpr);
    gl.uniform1f(u.u_brightness, config.brightness);
    gl.uniform1f(u.u_shadowAlpha, config.shadowOpacity);
    gl.uniform1f(u.u_shadowSpread, config.shadowSpread * dpr);
    gl.uniform1f(u.u_shadowOffY, config.shadowOffsetY * dpr);
    gl.uniform1f(u.u_bevelMode, config.bevelMode);

    // per-panel：只有 center/size 不同，其余 config uniform 上面设一次即可；
    // BLEND 已开，多块自然叠加；blur 背景按 blurAmount 缓存，多块不重算。
    // 带 clip 的面板用 scissor 截断在裁剪框内（GL 原点在左下，y 要翻转）。
    for (const panel of panels) {
      if (panel.clip) {
        const sw = Math.max(0, Math.round(panel.clip.w * dpr));
        const sh = Math.max(0, Math.round(panel.clip.h * dpr));
        if (sw === 0 || sh === 0) continue;
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(Math.round(panel.clip.x * dpr), H - Math.round(panel.clip.y * dpr) - sh, sw, sh);
      } else {
        gl.disable(gl.SCISSOR_TEST);
      }
      gl.uniform2f(u.u_center, panel.cx * dpr, panel.cy * dpr);
      gl.uniform2f(u.u_size, panel.w * dpr, panel.h * dpr);
      this.drawQuad(this.glassP, this.panelBuf);
    }
    gl.disable(gl.SCISSOR_TEST); // 别把 scissor 泄漏给下一帧的 blit/blur pass
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.handleContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.handleContextRestored);
    if (!this.initialized || this.contextLost) return;
    const gl = this.gl;
    gl.deleteProgram(this.blitP);
    gl.deleteProgram(this.blurP);
    gl.deleteProgram(this.glassP);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteBuffer(this.panelBuf);
    gl.deleteTexture(this.bgTex);
    if (this.blurA) { gl.deleteFramebuffer(this.blurA.fbo); gl.deleteTexture(this.blurA.tex); }
    if (this.blurB) { gl.deleteFramebuffer(this.blurB.fbo); gl.deleteTexture(this.blurB.tex); }
    this.initialized = false;
  }

  // ── internals ──
  private ensureFBOs(w: number, h: number): void {
    if (this.blurA && this.blurA.w === w && this.blurA.h === h) return;
    const gl = this.gl;
    if (this.blurA) { gl.deleteFramebuffer(this.blurA.fbo); gl.deleteTexture(this.blurA.tex); }
    if (this.blurB) { gl.deleteFramebuffer(this.blurB.fbo); gl.deleteTexture(this.blurB.tex); }
    this.blurA = this.makeFBO(w, h);
    this.blurB = this.makeFBO(w, h);
    this.bgReady = false;
  }

  private makeFBO(w: number, h: number): FBO {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fbo, tex, w, h };
  }

  private drawQuad(prog: WebGLProgram, buf: WebGLBuffer): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private link(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, vsSrc);
    const fs = this.compile(gl.FRAGMENT_SHADER, fsSrc);
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("Program link failed: " + gl.getProgramInfoLog(p));
    }
    return p;
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error("Shader compile failed: " + gl.getShaderInfoLog(s));
    }
    return s;
  }

  private locs(prog: WebGLProgram, names: string[]): Record<string, WebGLUniformLocation | null> {
    const gl = this.gl;
    const out: Record<string, WebGLUniformLocation | null> = {};
    for (const n of names) out[n] = gl.getUniformLocation(prog, n);
    return out;
  }
}

export const DEFAULT_CONFIG: GlassConfig = {
  blurAmount: 0.8,
  refraction: 4.35,
  chromAberration: 0,
  edgeHighlight: 0,
  specular: 0,
  fresnel: 2,
  distortion: 0.0,
  cornerRadius: 32,
  zRadius: 37,
  opacity: 1.0,
  saturation: 0.0,
  tintStrength: 0.0,
  brightness: 0.0,
  shadowOpacity: 0.3,
  shadowSpread: 12,
  shadowOffsetY: 4,
  bevelMode: 0,
};
