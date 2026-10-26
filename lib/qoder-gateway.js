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
var import_loopback = require("./loopback");
var import_qoder_client = require("./qoder-client");
var import_qoder_shim = require("./qoder-shim");
var import_log = require("./log");
const MODELS_TTL_MS = 10 * 60 * 1e3;
const CATALOG_FAILURE_BACKOFF_MS = 3e4;
function createQoderGateway(options) {
  const logger = options.logger;
  let cachedModels = [];
  let catalogAt = 0;
  let catalogFailedAt = 0;
  let catalogErrorText = "";
  let catalogInFlight;
  async function directoryCredentials() {
    const credentials = await options.credentials();
    return credentials.filter((credential) => credential.token !== "");
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
    if (catalogFailedAt > 0 && Date.now() - catalogFailedAt < CATALOG_FAILURE_BACKOFF_MS) {
      if (cachedModels.length > 0) return cachedModels;
      throw new Error(`Qoder model directory read failed recently, backing off: ${catalogErrorText}`);
    }
    catalogInFlight = (async () => {
      try {
        const candidates = await directoryCredentials();
        if (candidates.length === 0) throw new Error("no Qoder sign-in found on this machine");
        let lastError;
        for (const credential of candidates) {
          try {
            const read = await clientFor(credential).fetchModels();
            cachedModels = read;
            catalogAt = Date.now();
            catalogFailedAt = 0;
            return read;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError ?? new Error("no Qoder sign-in could read the model directory");
      } catch (error) {
        catalogFailedAt = Date.now();
        catalogErrorText = error instanceof Error ? error.message : String(error);
        throw error;
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
    let credentials;
    try {
      credentials = (await options.credentials("chat")).filter((credential) => credential.token !== "");
    } catch (error) {
      (0, import_loopback.writeOpenAIError)(res, 503, "upstream_unavailable", String(error instanceof Error ? error.message : error));
      return;
    }
    if (credentials.length === 0) {
      (0, import_loopback.writeOpenAIError)(res, 503, "upstream_unavailable", "no Qoder sign-in found on this machine");
      return;
    }
    if (watcher.signal.aborted) return;
    const directory = roster.find((entry) => entry.id === model);
    const call = (0, import_qoder_shim.qoderRequestBody)(raw, model, directory);
    const attemptOnce = async (credential) => {
      const result = await clientFor(credential).chatStream(call.body, call.model, {
        ...call.options,
        extraHeaders: {
          "X-Model-Key": model,
          "X-Model-Source": "system"
        },
        signal: watcher.signal
      });
      if (!result.ok) return { ok: false, status: result.status, message: result.message, kind: result.kind, retryAfter: result.retryAfter };
      let relayed2;
      try {
        relayed2 = await (0, import_qoder_shim.openQoderResponse)(result.response, model, {
          onFailure: (error) => {
            logger?.warn?.(import_log.LOG_PREFIX + ": qoder relay stream failed mid-flight", error);
            if (!(error instanceof Error && error.name === "AbortError") && !watcher.signal.aborted) {
              options.onAttemptFailure?.(credential, { status: 0, kind: "server" });
            }
          }
        });
      } catch (error) {
        const gone = watcher.signal.aborted || error instanceof Error && error.name === "AbortError";
        if (gone) return { ok: false, status: 0, kind: "aborted", message: "the caller went away while the answer was being read" };
        return { ok: false, status: 0, kind: "server", message: `relay read failed: ${String(error instanceof Error ? error.message : error)}` };
      }
      if (relayed2.status !== 200) {
        const detail = await relayed2.text().catch(() => "");
        return { ok: false, status: relayed2.status, message: detail, retryAfter: relayed2.headers.get("retry-after") };
      }
      return { ok: true, relayed: relayed2 };
    };
    const rotates = (status, kind) => {
      if (kind === "aborted") return false;
      if (status === 0) return true;
      return kind === "authentication" || kind === "soft_rate" || kind === "hard_credit" || status === 401 || status === 402 || status === 429;
    };
    let opened;
    for (let index = 0; index < credentials.length; index += 1) {
      if (watcher.signal.aborted) return;
      const credential = credentials[index];
      if (credential === void 0) continue;
      const attempt = await attemptOnce(credential);
      if (attempt.ok) {
        opened = attempt;
        break;
      }
      opened = attempt;
      if (!rotates(attempt.status, attempt.kind)) break;
      options.onAttemptFailure?.(credential, {
        status: attempt.status,
        ...attempt.kind === void 0 ? {} : { kind: attempt.kind },
        ...attempt.retryAfter === void 0 ? {} : { retryAfter: attempt.retryAfter }
      });
      if (index < credentials.length - 1) {
        logger?.warn?.(
          `${import_log.LOG_PREFIX}: qoder sign-in failed on ${model} (http ${attempt.status}); rotating`
        );
      }
    }
    if (opened === void 0 || !opened.ok) {
      if (opened !== void 0 && opened.kind === "aborted") return;
      const status = opened?.status ?? 502;
      const retryAfter = (0, import_loopback.retryAfterHeader)(opened?.retryAfter);
      if (retryAfter !== void 0) res.setHeader("Retry-After", retryAfter);
      const lifted = (0, import_loopback.liftUpstreamMessage)(opened?.message ?? "");
      (0, import_loopback.writeOpenAIError)(
        res,
        // A transport failure reports status 0; `writeHead(0)` throws, and the
        // answer the client gets is a 500 about the status code rather than the
        // refusal it can act on.
        status === 0 ? 502 : status,
        "upstream_error",
        lifted === "" ? "Qoder refused the request" : lifted
      );
      return;
    }
    const relayed = opened.relayed;
    if (relayed.body === null) {
      (0, import_loopback.writeOpenAIError)(res, 502, "upstream_error", "Qoder returned no stream");
      return;
    }
    if (watcher.signal.aborted) {
      void (0, import_loopback.relayStreamOf)(relayed).cancel().catch(() => {
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    void (0, import_loopback.pumpToResponse)((0, import_loopback.relayStreamOf)(relayed), res).catch((error) => {
      const aborted = watcher.signal.aborted || error instanceof Error && error.name === "AbortError";
      if (!aborted) {
        logger?.warn?.(import_log.LOG_PREFIX + ": qoder relay stream failed mid-flight", error);
      }
      if (res.writable) res.end();
    });
  }
  async function handle(req, res) {
    if (!(0, import_loopback.guardsPass)(req, res)) return;
    const url = (0, import_loopback.requestPathname)(req.url);
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
        logger?.warn?.(import_log.LOG_PREFIX + ": qoder directory refresh failed; serving the cached roster");
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
  const server = (0, import_loopback.createLoopbackServer)({ port: options.port, label: "qoder gateway", handle, logger });
  const ready = server.ready;
  const port = server.port;
  const baseUrl = server.baseUrl;
  return {
    ready,
    baseUrl,
    port,
    models: () => cachedModels,
    close: server.close
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  createQoderGateway
});
