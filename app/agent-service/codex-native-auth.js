"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { atomicWritePrivateFile, readPrivateFile, statIfExists } = require("./private-file");
const { CODEX_APP_SERVER_ARGS, resolveCodexRuntimeLayout } = require("./codex-runtime-paths");
const {
  assertRuntimeHomesSeparated, internalCodexHomePaths, resolveNativeHome, resolveUserHome,
} = require("./runtime-account-resolver");
const { NATIVE_CODEX_RUNTIME_ACCOUNT_ID } = require("./runtime-account");
const { serviceError } = require("./security");

const NATIVE_AUTH_PREFERENCE_FILE = ".shoggoth-native-auth.json";
const REFRESH_MARGIN_MS = 60_000;

function authUnavailable() {
  return serviceError("RUNTIME_AUTH_REQUIRED", "Local Codex sign-in is unavailable");
}

// This decodes metadata from a token returned by Codex, not a trust decision:
// OpenAI still validates the token. Neither the JWT nor its claims reach the UI.
function nativeChatGptTokens(value) {
  if (!value || value.authMethod !== "chatgpt" || typeof value.authToken !== "string"
    || value.authToken.length > 64 * 1024) return null;
  try {
    const parts = value.authToken.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/u.test(part))) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const auth = claims["https://api.openai.com/auth"];
    if (typeof auth?.chatgpt_account_id !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(auth.chatgpt_account_id)
      || !Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.exp * 1_000)
      || claims.exp <= 0) return null;
    return {
      accessToken: value.authToken,
      chatgptAccountId: auth.chatgpt_account_id,
      chatgptPlanType: typeof auth.chatgpt_plan_type === "string"
        && /^[a-z_]{1,64}$/u.test(auth.chatgpt_plan_type) ? auth.chatgpt_plan_type : null,
      expiresAt: claims.exp * 1_000,
    };
  } catch { return null; }
}

class NativeCodexAuth {
  constructor(options) {
    this.options = options;
    this.paths = options.paths;
    this.fs = options.fs || fs;
    this.now = options.now || Date.now;
    this.pending = null;
    this.host = null;
    this.closed = false;
    this.cleanupIncomplete = false;
    this.accountId = null;
  }

  open() { this.closed = false; }

  enabled(codexHome) {
    const target = path.join(codexHome, NATIVE_AUTH_PREFERENCE_FILE);
    // A malformed preference cannot silently undo an explicit logout.
    try {
      if (!statIfExists(this.fs, target)) return true;
      readPrivateFile(target, { fs: this.fs, maxBytes: 1024 });
      return false;
    } catch { return false; }
  }

  disable(codexHome) {
    atomicWritePrivateFile(path.join(codexHome, NATIVE_AUTH_PREFERENCE_FILE),
      JSON.stringify({ version: 1, disabled: true }) + "\n", {
        fs: this.fs, trustedRoot: this.paths.trustedRoot,
      });
  }

  async read({ refreshToken = false, previousAccountId = null } = {}) {
    if (this.closed || this.cleanupIncomplete) throw authUnavailable();
    // Share an in-flight read across Profiles. A forced refresh must not be
    // satisfied by a concurrent metadata read that still has the rejected JWT.
    if (this.pending) {
      const result = await this.pending;
      if (!refreshToken) return this._matching(result, previousAccountId);
      return this.read({ refreshToken, previousAccountId });
    }
    const pending = this._read(refreshToken, previousAccountId);
    this.pending = pending;
    try {
      const result = this._matching(await pending, previousAccountId);
      if (result) this.accountId ||= result.chatgptAccountId;
      return result;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  _matching(tokens, previousAccountId) {
    const expectedAccountId = previousAccountId || this.accountId;
    if (this.closed || (tokens && expectedAccountId
      && tokens.chatgptAccountId !== expectedAccountId)) throw authUnavailable();
    return tokens;
  }

  _createHost() {
    if (this.options.hostFactory) return this.options.hostFactory();
    const userHome = resolveUserHome(this.fs, this.options.homedir || os.homedir());
    const home = resolveNativeHome(this.fs, this.options.parentEnv || process.env, userHome, "codex");
    if (!statIfExists(this.fs, home)) return null;
    for (const managedHome of internalCodexHomePaths(this.paths)) {
      const canonicalHome = statIfExists(this.fs, managedHome)
        ? this.fs.realpathSync(managedHome) : managedHome;
      assertRuntimeHomesSeparated(home, canonicalHome, "Native and bundled Codex Homes");
    }
    const layout = resolveCodexRuntimeLayout(this.options);
    const binding = {
      runtime: "codex", runtimeProfileId: "shoggoth-native-auth-source",
      runtimeAccountId: NATIVE_CODEX_RUNTIME_ACCOUNT_ID,
    };
    // A short-lived, auth-only process uses the bundled version, even if the
    // system CLI is absent. It starts no threads, tools, or model requests.
    const { CodexRuntimeHost } = require("./codex-runtime-host");
    return new CodexRuntimeHost({
      ...this.options, paths: undefined, nativeAuthSource: true,
      parentEnv: { ...(this.options.parentEnv || process.env), HOME: userHome },
      runtimeBinding: binding, cwd: userHome,
      runtimeEnvironment: Object.freeze({
        ...binding, kind: "native-user", installationKind: "bundled",
        homeKind: "native", strategy: "native", home, nativeHome: home,
        integrationRoot: null, binaryPath: layout.runtimePath,
        launchArgs: Object.freeze([
          "-c", 'model_provider="openai"', ...CODEX_APP_SERVER_ARGS,
        ]),
        spawnEnv: Object.freeze({ HOME: userHome, CODEX_HOME: home }),
        configurationMode: "overlay",
      }),
      initializeTimeoutMs: 5_000, requestTimeoutMs: 5_000,
    });
  }

  async _read(refreshToken, previousAccountId) {
    const host = this._createHost();
    if (!host) return null;
    this.host = host;
    try {
      await host.initialize();
      if (this.closed) throw authUnavailable();
      let tokens = this._matching(await host.readNativeChatGptTokens(false), previousAccountId);
      if (tokens && (refreshToken || tokens.expiresAt <= this.now() + REFRESH_MARGIN_MS)) {
        tokens = this._matching(await host.readNativeChatGptTokens(true), previousAccountId);
      }
      return tokens && tokens.expiresAt > this.now() ? tokens : null;
    } finally {
      try { await host.stop(); } catch {
        this.cleanupIncomplete = true;
        throw serviceError("CODEX_RUNTIME_CLEANUP_INCOMPLETE", "Codex auth process cleanup failed");
      } finally {
        if (this.host === host) this.host = null;
      }
    }
  }

  async close() {
    this.closed = true;
    const results = await Promise.allSettled([this.host?.stop(), this.pending]);
    this.accountId = null;
    if (this.cleanupIncomplete || results[0].status === "rejected") {
      throw serviceError("CODEX_RUNTIME_CLEANUP_INCOMPLETE", "Codex auth process cleanup failed");
    }
  }
}

module.exports = { NativeCodexAuth, NATIVE_AUTH_PREFERENCE_FILE, nativeChatGptTokens };
