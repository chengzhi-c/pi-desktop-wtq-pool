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
var trusted_process_exports = {};
__export(trusted_process_exports, {
  trustedSystemRootOf: () => trustedSystemRootOf,
  trustedWindowsChildEnv: () => trustedWindowsChildEnv,
  trustedWindowsPowerShell: () => trustedWindowsPowerShell
});
module.exports = __toCommonJS(trusted_process_exports);
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
function trustedSystemRootOf(env) {
  if (process.platform === "win32") {
    try {
      return import_node_fs.realpathSync.native("\\\\?\\GLOBALROOT\\SystemRoot");
    } catch {
      return void 0;
    }
  }
  const value = env["SystemRoot"]?.trim() || env["windir"]?.trim();
  return value === void 0 || value === "" ? void 0 : value;
}
function trustedWindowsPowerShell(env) {
  const systemRoot = trustedSystemRootOf(env);
  if (systemRoot === void 0) return void 0;
  return (0, import_node_path.join)(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
function trustedWindowsChildEnv(env, options = {}) {
  const systemRoot = trustedSystemRootOf(env);
  if (systemRoot === void 0) return {};
  const result = {};
  if (options.inheritTemp === true) {
    for (const name of ["TEMP", "TMP"]) {
      const value = env[name];
      if (value !== void 0 && value !== "") result[name] = value;
    }
  }
  result.SystemRoot = systemRoot;
  result.windir = systemRoot;
  if (options.includeSystemDrive === true && /^[A-Za-z]:\\/.test(systemRoot)) {
    result.SystemDrive = systemRoot.slice(0, 2);
  }
  result.PATH = (0, import_node_path.join)(systemRoot, "System32");
  result.PSModulePath = (0, import_node_path.join)(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  return result;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  trustedSystemRootOf,
  trustedWindowsChildEnv,
  trustedWindowsPowerShell
});
