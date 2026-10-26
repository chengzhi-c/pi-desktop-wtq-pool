var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var login_exports = {};
__export(login_exports, {
  pollDeviceLogin: () => pollDeviceLogin,
  startDeviceLogin: () => startDeviceLogin
});
module.exports = __toCommonJS(login_exports);
var import_upstream = require("./upstream");
const CN_BASE = "https://copilot.tencent.com";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CN_ORIGIN = "https://www.codebuddy.cn";
const GLOBAL_ORIGIN = "https://www.workbuddy.ai";
const LOGIN_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const REQUEST_TIMEOUT_MS = 3e4;
const DEFAULT_DOMAIN = {
  cn: "www.codebuddy.cn",
  global: "www.workbuddy.ai"
};
function baseFor(realm) {
  return realm === "global" ? GLOBAL_BASE : CN_BASE;
}
function originFor(realm) {
  return realm === "global" ? GLOBAL_ORIGIN : CN_ORIGIN;
}
function loginHeaders(origin) {
  return {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": origin,
    "Referer": `${origin}/`,
    "User-Agent": LOGIN_UA,
    "X-Requested-With": "XMLHttpRequest",
    // The login channel pins its own build (`LOGIN_UA`), but it shares the CN
    // origin with chat, so its token must not ride a pooled socket either.
    "Connection": "close"
  };
}
async function callLogin(url, headers, fetchImpl, body) {
  const response = await fetchImpl(url, {
    redirect: "error",
    method: body === void 0 ? "GET" : "POST",
    headers,
    ...body === void 0 ? {} : { body },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`workbuddy login endpoint answered ${response.status}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("workbuddy login endpoint did not answer JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("workbuddy login endpoint did not answer an object");
  }
  const document = parsed;
  const data = typeof document["data"] === "object" && document["data"] !== null ? document["data"] : {};
  return {
    code: typeof document["code"] === "number" ? document["code"] : -1,
    msg: typeof document["msg"] === "string" ? document["msg"] : "",
    data
  };
}
function stringField(data, key) {
  const value = data[key];
  return typeof value === "string" ? value : "";
}
async function startDeviceLogin(realm, fetchImpl = fetch) {
  const envelope = await callLogin(
    `${baseFor(realm)}/v2/plugin/auth/state?platform=CLI`,
    loginHeaders(originFor(realm)),
    fetchImpl,
    "{}"
  );
  const state = stringField(envelope.data, "state");
  const authUrl = stringField(envelope.data, "authUrl");
  if (state === "" || authUrl === "") {
    throw new Error(`workbuddy login start gave no state or url: ${envelope.msg}`);
  }
  return { state, authUrl };
}
async function readLoginAccount(base, headers, state, accessToken, fetchImpl) {
  const empty = { uid: "", uin: "", enterpriseId: "", nickname: "" };
  let envelope;
  try {
    envelope = await callLogin(
      `${base}/v2/plugin/login/account?state=${encodeURIComponent(state)}`,
      { ...headers, "Authorization": `Bearer ${accessToken}` },
      fetchImpl
    );
  } catch {
    return empty;
  }
  if (envelope.code !== 0) return empty;
  return {
    uid: stringField(envelope.data, "uid"),
    // The CN gateway names the billing identity `uin` and the international one
    // `uid`; either one is what the pool keys an account on.
    uin: stringField(envelope.data, "uin"),
    enterpriseId: stringField(envelope.data, "enterpriseId"),
    nickname: stringField(envelope.data, "nickname")
  };
}
async function pollDeviceLogin(realm, state, fetchImpl = fetch) {
  const base = baseFor(realm);
  const headers = loginHeaders(originFor(realm));
  const token = await callLogin(
    `${base}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
    headers,
    fetchImpl
  );
  const accessToken = stringField(token.data, "accessToken");
  if (token.code !== 0 || accessToken === "") return { status: "pending" };
  const domain = stringField(token.data, "domain");
  const identity = await readLoginAccount(base, headers, state, accessToken, fetchImpl);
  const stamped = domain === "" ? DEFAULT_DOMAIN[realm] : domain;
  return {
    status: "ok",
    signIn: {
      region: (0, import_upstream.regionOf)(stamped),
      accessToken,
      refreshToken: stringField(token.data, "refreshToken"),
      expiresAtMs: (0, import_upstream.tokenExpiryMs)(
        typeof token.data["expiresIn"] === "number" ? token.data["expiresIn"] : void 0
      ),
      domain: stamped,
      ...identity
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  pollDeviceLogin,
  startDeviceLogin
});
