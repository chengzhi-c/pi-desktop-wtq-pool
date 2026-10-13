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
var qoder_gateway_exports = {};
__export(qoder_gateway_exports, {
  createQoderGateway: () => createQoderGateway
});
module.exports = __toCommonJS(qoder_gateway_exports);
var import_node_http = require("node:http");
var import_node_stream = require("node:stream");
var import_loopback = require("./loopback");
var import_qoder_client = require("./qoder-client");
var import_qoder_shim = require("./qoder-shim");
const MODELS_TTL_MS = 10 * 60 * 1e3;
function createQoderGateway(options) {
  const logger = options.logger;
  let cachedModels = [];
  let catalogAt = 0;
  let catalogInFlight;
  async function firstCredential(purpose) {
    const credentials = await options.credentials(purpose);
    const usable = credentials.find((credential) => credential.token !== "");
    if (usable === void 0) throw new Error("no Qoder sign-in found on this machine");
    return usable;
  }
  function clientFor(credential) {
    return new import_qoder_client.QoderUpstreamClient({
      region: options.region,
      credential: async () => credential,
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
    const watcher = new AbortController();
    res.on("close", () => watcher.abort());
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
    let reason = "Qoder model directory is not available yet";
    let roster = await models().catch((error) => {
      reason = "Qoder model directory could not be read: " + String(error instanceof Error ? error.message : error);
      return cachedModels;
    });
    if (watcher.signal.aborted) return;
    if (roster.length === 0) roster = cachedModels;
    if (roster.length === 0) {
      (0, import_loopback.writeOpenAIError)(res, 503, "upstream_unavailable", reason);
      return;
    }
    if (!roster.some((entry) => entry.id === model)) {
      (0, import_loopback.writeOpenAIError)(res, 404, "not_found", `model not in the Qoder directory: ${model}`);
      return;
    }
    let credential;
    try {
      credential = await firstCredential("chat");
    } catch (error) {
      (0, import_loopback.writeOpenAIError)(res, 503, "upstream_unavailable", String(error instanceof Error ? error.message : error));
      return;
    }
    if (watcher.signal.aborted) return;
    const directory = roster.find((entry) => entry.id === model);
    const call = (0, import_qoder_shim.qoderRequestBody)(raw, model, directory);
    const result = await clientFor(credential).chatStream(call.body, call.model, {
      ...call.options,
      extraHeaders: {
        "X-Model-Key": model,
        "X-Model-Source": "system"
      },
      signal: watcher.signal
    });
    if (!result.ok) {
      if (result.status === 0) {
        (0, import_loopback.writeOpenAIError)(res, 502, "upstream_error", result.message);
        return;
      }
      (0, import_loopback.writeOpenAIError)(res, result.status, "upstream_error", result.message);
      return;
    }
    const relayed = await (0, import_qoder_shim.openQoderResponse)(result.response, model, {
      onFailure: (error) => {
        logger?.warn?.("pi-desktop-wtq-pool: qoder relay stream failed mid-flight", error);
      }
    });
    if (relayed.status !== 200) {
      const detail = await relayed.text().catch(() => "");
      const status = relayed.status;
      const retryAfter = relayed.headers.get("retry-after");
      if (retryAfter !== null) res.setHeader("Retry-After", retryAfter);
      (0, import_loopback.writeOpenAIError)(res, status, "upstream_error", detail === "" ? "Qoder refused the request" : detail);
      return;
    }
    if (relayed.body === null) {
      (0, import_loopback.writeOpenAIError)(res, 502, "upstream_error", "Qoder returned no stream");
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
      const aborted = watcher.signal.aborted || error instanceof Error && error.name === "AbortError";
      if (!aborted) {
        logger?.warn?.("pi-desktop-wtq-pool: qoder relay stream failed mid-flight", error);
      }
      if (res.writable) res.end();
    });
    body.pipe(res);
  }
  async function handle(req, res) {
    if (!(0, import_loopback.guardsPass)(req, res)) return;
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
      const credentials = await options.credentials().catch(() => []);
      (0, import_loopback.writeJson)(res, 200, { ok: true, source: "qoder", credentials: credentials.length, models: cachedModels.length });
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
        logger?.warn?.("pi-desktop-wtq-pool: qoder directory refresh failed; serving the cached roster");
      }
      const ids = options.listedIds?.();
      const listed = ids === void 0 ? served : (0, import_loopback.listedModels)(served, ids);
      (0, import_loopback.writeJson)(res, 200, {
        object: "list",
        data: listed.map((model) => ({ id: model.id, object: "model", created: 0, owned_by: "qoder" }))
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
    logger?.warn?.("pi-desktop-wtq-pool: qoder gateway server error", error);
  });
  const port = () => {
    const address = server.address();
    return address === null || typeof address === "string" ? 0 : address.port;
  };
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("qoder gateway has no listening address");
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
  createQoderGateway
});
