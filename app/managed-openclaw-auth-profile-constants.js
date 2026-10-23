"use strict";

// Shared wire/storage constants. Service must not load the Main/Worker config
// scope calculator or any OpenClaw product module to validate credentials.
const NATIVE_AUTH_API = "openclaw-auth-profile";
const NATIVE_AUTH_PREFIX = "external.provider.authProfile.";
const NATIVE_AUTH_KEY = /^@auth\.[a-f0-9]{64}$/;
const NATIVE_AUTH_SECRET_PREFIX = "openclaw-auth-profile-credential-";
// Preserve the existing encrypted container schema and namespace ownership.
const NATIVE_AUTH_SECRET_KIND = "external-provider-api-key";

module.exports = Object.freeze({ NATIVE_AUTH_API, NATIVE_AUTH_PREFIX, NATIVE_AUTH_KEY,
  NATIVE_AUTH_SECRET_PREFIX, NATIVE_AUTH_SECRET_KIND });
