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
var trae_gateway_exports = {};
__export(trae_gateway_exports, {
  createTraeGateway: () => createTraeGateway
});
module.exports = __toCommonJS(trae_gateway_exports);
var import_node_http = require("node:http");
var import_node_stream = require("node:stream");
var import_loopback = require("./loopback");
var import_trae_upstream = require("./trae-upstream");
var import_trae_shim = require("./trae-shim");
const MODELS_TTL_MS = 10 * 60 * 1e3;
function functionMapOf(models) {
  const map = /* @__PURE__ */ new Map();
  for (const model of models) {
    if (model.function !== void 0 && model.function !== "") map.set(model.id, model.function);
  }
  return map;
}
function capabilityMapOf(models) {
  const map = /* @__PURE__ */ new Map();
  for (const model of models) {
    map.set(model.id, model.reasoning ?? { supported: [] });
  }
  return map;
}
function createTraeGateway(options) {
  const logger = options.logger;
  let cachedModels = [];
  let catalogAt = 0;
  let catalogInFlight;
  async function firstCredential() {
    const credentials = await options.credentials();
    const usable = credentials.find((credential) => credential.accessToken !== "");
    if (usable === void 0) throw new Error("no Trae sign-in found on this machine");
    return usable;
  }
  function clientFor(credential) {
    return new import_trae_upstream.TraeSoloUpstreamClient({
      credential: async () => credential,
      identity: async () => options.identity(credential),
      ...options.fetchImpl === void 0 ? {} : { fetchImpl: options.fetchImpl }
    });
  }
  async function models() {
    const fresh = Date.now() - catalogAt < MODELS_TTL_MS;
    if (fresh && cachedModels.length > 0) return cachedModels;
    if (catalogInFlight !== void 0) return catalogInFlight;
    catalogInFlight = (async () => {
      try {
        const credential = await firstCredential();
        const read = await clientFor(credential).fetchModels();
        cachedModels = read;
        catalogAt = Date.now();
        return read;
      } finally {
        catalogInFlight = void 0;
      }
    })();
    return catalogInFlight;
  }
  async function chatCompletions(req, res) {
    if (!(0, import_loopback.isJsonContentType)(req)) {
      (0, import_loopback.writeOpenAIError)(res, 415, "unsupported_media_type", "Content-Type must be application/json");
      return;
    }
    const raw = (await (0, import_loopback.readRequestBody)(req)).toString("utf8");
    let model = "";
    try {
      model = JSON.parse(raw)["model"] ?? "";
    } catch {
      model = "";
    }
    if (typeof model !== "string" || model.trim() === "") {
      (0, import_loopback.writeOpenAIError)(res, 400, "invalid_request_error", "model is required");
      return;
    }
    model = model.trim();
    const directory = await models().catch(() => cachedModels);
    let functions = functionMapOf(directory);
    if (functions.size === 0) functions = functionMapOf(cachedModels);
    if (functions.size === 0) {
      (0, import_loopback.writeOpenAIError)(res, 503, "upstream_unavailable", "Trae model directory is not available yet");
      return;
    }
    if (!directory.some((entry) => entry.id === model) && !cachedModels.some((entry) => entry.id === model)) {
      (0, import_loopback.writeOpenAIError)(res, 404, "not_found", `model not in the Trae directory: ${model}`);
      return;
    }
    let credential;
    try {
      credential = await firstCredential();
    } catch (error) {
      (0, import_loopback.writeOpenAIError)(res, 503, "upstream_unavailable", String(error instanceof Error ? error.message : error));
      return;
    }
    const capabilities = capabilityMapOf(directory);
    const watcher = new AbortController();
    res.on("close", () => watcher.abort());
    const result = await clientFor(credential).chatStream(
      raw,
      watcher.signal,
      functions.get(model),
      capabilities.get(model)
    );
    if (!result.ok) {
      if (result.status === 0) {
        (0, import_loopback.writeOpenAIError)(res, 502, "upstream_error", result.message);
        return;
      }
      (0, import_loopback.writeOpenAIError)(res, result.status, "upstream_error", result.message);
      return;
    }
    const relayed = await (0, import_trae_shim.openTraeResponse)(result.response, model);
    if (relayed.status !== 200) {
      const detail = await relayed.text().catch(() => "");
      (0, import_loopback.writeOpenAIError)(res, relayed.status, "upstream_error", detail === "" ? "Trae SOLO refused the request" : detail);
      return;
    }
    if (relayed.body === null) {
      (0, import_loopback.writeOpenAIError)(res, 502, "upstream_error", "Trae SOLO returned no stream");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    const body = import_node_stream.Readable.fromWeb(relayed.body);
    body.on("error", (error) => {
      logger?.warn?.("pi-desktop-xdpool: trae relay stream failed mid-flight", error);
      if (res.writable) res.end();
    });
    body.pipe(res);
  }
  async function handle(req, res) {
    if (!(0, import_loopback.hostIsLoopback)(req.headers.host)) {
      (0, import_loopback.writeOpenAIError)(res, 403, "host_not_allowed", "Host header must name the loopback interface");
      return;
    }
    if (!(0, import_loopback.originIsLoopback)(req.headers.origin)) {
      (0, import_loopback.writeOpenAIError)(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
      return;
    }
    if (!(0, import_loopback.bearerAccepted)(req)) {
      (0, import_loopback.writeOpenAIError)(res, 401, "unauthorized", "missing or invalid Authorization bearer");
      return;
    }
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
      const credentials = await options.credentials().catch(() => []);
      (0, import_loopback.writeJson)(res, 200, { ok: true, source: "trae", credentials: credentials.length, models: cachedModels.length });
      return;
    }
    if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
      let served;
      try {
        served = await models();
      } catch (error) {
        served = cachedModels;
        if (served.length === 0) {
          (0, import_loopback.writeOpenAIError)(res, 503, "upstream_unavailable", String(error instanceof Error ? error.message : error));
          return;
        }
        logger?.warn?.("pi-desktop-xdpool: trae directory refresh failed; serving the cached roster");
      }
      const ids = options.listedIds?.();
      const listed = ids === void 0 ? served : (0, import_loopback.listedModels)(served, ids);
      (0, import_loopback.writeJson)(res, 200, {
        object: "list",
        data: listed.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "trae" }))
      });
      return;
    }
    if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
      await chatCompletions(req, res);
      return;
    }
    (0, import_loopback.writeOpenAIError)(res, 404, "not_found", `no such route: ${req.method} ${url}`);
  }
  const server = (0, import_node_http.createServer)((req, res) => {
    void (0, import_loopback.answerRequest)(res, () => handle(req, res), logger);
  });
  const ready = new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(options.port ?? 0, "127.0.0.1");
  server.on("error", (error) => {
    logger?.warn?.("pi-desktop-xdpool: trae gateway server error", error);
  });
  const port = () => {
    const address = server.address();
    return address === null || typeof address === "string" ? 0 : address.port;
  };
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("trae gateway has no listening address");
    }
    return `http://127.0.0.1:${address.port}`;
  };
  return {
    ready,
    baseUrl,
    port,
    models: () => cachedModels,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createTraeGateway
});
