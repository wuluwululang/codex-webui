import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import { readTokenStore, resolveDataDir, tokenStorePath } from "./token-store.js";
import { UsageTracker } from "./usage-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const nodeModulesDir = path.join(rootDir, "node_modules");
const dataDir = resolveDataDir();
const uploadDir = path.join(dataDir, "uploads");
const inlineImageDir = path.join(dataDir, "inline-images");
const threadSettingsStorePath = path.join(dataDir, "thread-settings.json");

const PORT = Number(process.env.PORT || 9526);
const HOST = process.env.HOST || "0.0.0.0";
const DEFAULT_CWD = process.env.CODEX_MOBILE_CWD || rootDir;
const usesEnvironmentTokens = Boolean(
  String(process.env.CODEX_MOBILE_TOKEN || "").trim()
  || String(process.env.CODEX_MOBILE_TOKEN_SCOPES || "").trim()
);
let tokenScopes = createTokenScopes();
let defaultTokenScope = tokenScopes.values().next().value;
let tokenStoreModifiedMs = currentTokenStoreModifiedMs();
const usageTracker = new UsageTracker(dataDir);
const inlineImages = new Map();
const inlineImageLimit = 80;
let threadSettingsStore = null;

const allowedMethods = new Set([
  "account/read",
  "account/login/start",
  "account/logout",
  "account/rateLimits/read",
  "config/read",
  "model/list",
  "thread/list",
  "thread/start",
  "thread/resume",
  "thread/read",
  "thread/turns/list",
  "thread/name/set",
  "thread/archive",
  "thread/unarchive",
  "thread/loaded/list",
  "turn/start",
  "turn/steer",
  "turn/interrupt"
]);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon"
};

const vendorFiles = new Map([
  ["/vendor/markdown-it.min.js", path.join(nodeModulesDir, "markdown-it", "dist", "markdown-it.min.js")],
  ["/vendor/purify.min.js", path.join(nodeModulesDir, "dompurify", "dist", "purify.min.js")]
]);

const imageExtensionsByMime = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"]
]);

const imageMimesByExtension = new Map(
  Array.from(imageExtensionsByMime, ([mime, ext]) => [ext, mime])
);
const LOCAL_FILE_CACHE_CONTROL = "private, max-age=0, must-revalidate";
const INLINE_IMAGE_CACHE_CONTROL = "private, max-age=31536000, immutable";

function resolveCodexCommand() {
  const appServerArgs = ["app-server", "--listen", "stdio://"];
  const explicitPath = String(
    process.env.CODEX_MOBILE_CODEX_PATH || process.env.CODEX_CLI_PATH || ""
  ).trim();

  if (explicitPath) {
    return {
      command: explicitPath,
      args: appServerArgs,
      shell: false,
      label: explicitPath
    };
  }

  const bundledPath = findLatestBundledCodex();
  if (bundledPath) {
    return {
      command: bundledPath,
      args: appServerArgs,
      shell: false,
      label: bundledPath
    };
  }

  return {
    command: "codex",
    args: appServerArgs,
    shell: process.platform === "win32",
    label: "codex"
  };
}

function findLatestBundledCodex() {
  if (process.platform !== "win32") return "";

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  try {
    return readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const exePath = path.join(binRoot, entry.name, "codex.exe");
        if (!existsSync(exePath)) return null;
        return { exePath, mtimeMs: statSync(exePath).mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.exePath || "";
  } catch {
    return "";
  }
}

class CodexBridge {
  constructor() {
    this.proc = null;
    this.spawnInfo = null;
    this.nextId = 1;
    this.pending = new Map();
    this.clients = new Set();
    this.serverRequests = new Map();
    this.stderrLines = [];
    this.ready = this.start();
  }

  start() {
    return new Promise((resolve, reject) => {
      try {
        this.spawnInfo = resolveCodexCommand();
        this.proc = spawn(this.spawnInfo.command, this.spawnInfo.args, {
          cwd: rootDir,
          shell: this.spawnInfo.shell,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
      } catch (error) {
        reject(error);
        return;
      }

      this.proc.once("error", (error) => {
        reject(error);
        this.broadcast({ type: "bridge-error", error: error.message });
      });

      this.proc.once("exit", (code, signal) => {
        const message = `codex app-server exited (${code ?? signal ?? "unknown"})`;
        for (const pending of this.pending.values()) {
          pending.reject(new Error(message));
        }
        this.pending.clear();
        this.broadcast({ type: "bridge-error", error: message });
      });

      const rl = readline.createInterface({ input: this.proc.stdout });
      rl.on("line", (line) => this.handleLine(line));
      this.proc.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        this.stderrLines.push(...text.split(/\r?\n/).filter(Boolean));
        this.stderrLines = this.stderrLines.slice(-60);
        this.broadcast({ type: "codex-stderr", text });
      });

      this.requestRaw("initialize", {
        clientInfo: {
          name: "codex_mobile_web",
          title: "Codex Mobile Web",
          version: "0.1.0"
        },
        capabilities: { experimentalApi: true }
      })
        .then((result) => {
          this.notify("initialized", {});
          this.broadcast({ type: "bridge-ready", result, codexCommand: this.spawnInfo.label });
          resolve(result);
        })
        .catch(reject);
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.broadcast({ type: "codex-raw", line });
      return;
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Codex request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.serverRequests.set(String(message.id), message);
      this.broadcast({ type: "server-request", request: message });
      return;
    }

    this.broadcast({ type: "codex-notification", notification: stripInlineDataImages(message) });
  }

  send(message) {
    if (!this.proc?.stdin?.writable) {
      throw new Error("Codex app-server is not writable");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  requestRaw(method, params = {}) {
    const id = this.nextId++;
    const message = { method, id, params };
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }
      }, 120000).unref();
    });
    this.send(message);
    return promise;
  }

  async request(method, params = {}, scope = defaultTokenScope) {
    await this.ready;
    if (!allowedMethods.has(method)) {
      throw new Error(`Method not allowed: ${method}`);
    }
    return this.requestRaw(method, normalizeParams(method, params, scope));
  }

  async respond(id, result) {
    await this.ready;
    const requestId = String(id);
    if (!this.serverRequests.has(requestId)) {
      throw new Error("Request is no longer pending");
    }
    this.serverRequests.delete(requestId);
    this.send({ id, result });
    return {};
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  attach(client, scope = defaultTokenScope) {
    this.clients.add(client);
    client.sendJson({
      type: "hello",
      defaultCwd: scope.defaultCwd,
      threadFilterCwd: scope.threadFilterCwd,
      threadFilterCwds: scope.threadFilterCwds,
      tokenHash: scope.tokenHash,
      pendingServerRequests: Array.from(this.serverRequests.values())
    });
    client.once("close", () => this.clients.delete(client));
  }

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) {
        usageTracker.record(client.tokenScope?.id, { bytesOut: Buffer.byteLength(data) });
        client.send(data);
      }
    }
  }
}

function normalizeParams(method, params, scope = defaultTokenScope) {
  const next = { ...(params || {}) };

  if (method === "thread/start") {
    next.cwd = next.cwd || scope.defaultCwd;
    if (hasThreadFilter(scope) && !isPathAllowedInScope(scope, next.cwd)) {
      throw new Error("This token can only create sessions in the allowed folder.");
    }
    mkdirSync(next.cwd, { recursive: true });
    next.serviceName = "codex_mobile_web";
    if (!next.approvalPolicy) next.approvalPolicy = "on-request";
    if (!next.sandbox) next.sandbox = "workspace-write";
    normalizeReasoningEffortParam(next);
  }

  if (method === "thread/resume") {
    if (next.cwd === "") delete next.cwd;
    normalizeReasoningEffortParam(next);
  }

  if (method === "turn/start") {
    normalizeReasoningEffortParam(next);
    if (typeof next.input === "string") {
      next.input = [{ type: "text", text: next.input, text_elements: [] }];
    }
    if (Array.isArray(next.input)) {
      next.input = next.input.map((item) =>
        item?.type === "text" ? { text_elements: [], ...item } : item
      );
    }
  }

  if (method === "thread/list") {
    next.limit = next.limit || 40;
    if (hasThreadFilter(scope)) next.limit = Math.max(Number(next.limit) || 0, 500);
    if (!("archived" in next)) next.archived = false;
  }

  if (method === "thread/turns/list") {
    next.limit = Math.min(Math.max(Number(next.limit) || 20, 1), 100);
    next.sortDirection = next.sortDirection || "desc";
    next.itemsView = next.itemsView || "full";
  }

  return next;
}

const bridge = new CodexBridge();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname === "/api/info") {
      const scope = scopeFromToken(url.searchParams.get("token"));
      if (!scope) {
        sendJson(res, {
          authenticated: false,
          port: PORT,
          host: HOST,
          lanUrls: getLanUrls(PORT)
        });
        return;
      }
      recordHttpUsage(scope, req);
      sendJson(res, {
        authenticated: true,
        port: PORT,
        host: HOST,
        defaultCwd: scope.defaultCwd,
        threadFilterCwd: scope.threadFilterCwd,
        threadFilterCwds: scope.threadFilterCwds,
        lanUrls: getLanUrls(PORT),
        tokenHash: scope.tokenHash
      });
      return;
    }

    if (vendorFiles.has(url.pathname)) {
      const vendorPath = vendorFiles.get(url.pathname);
      if (!existsSync(vendorPath)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Vendor file not found");
        return;
      }

      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store"
      });
      createReadStream(vendorPath).pipe(res);
      return;
    }

    if (url.pathname === "/api/local-file") {
      const scope = scopeFromToken(url.searchParams.get("token"));
      if (!scope) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        res.end("Unauthorized");
        return;
      }
      recordHttpUsage(scope, req);

      const requestedPath = normalizeLocalPath(url.searchParams.get("path") || "");
      if (!requestedPath || !isLocalFileAccessible(scope, requestedPath) || !existsSync(requestedPath)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }

      const ext = path.extname(requestedPath);
      sendCachedFile(req, res, requestedPath, mimeTypes[ext] || "application/octet-stream");
      return;
    }

    if (url.pathname === "/api/inline-image") {
      const scope = scopeFromToken(url.searchParams.get("token"));
      const inlineId = url.searchParams.get("id") || "";
      if (!scope) {
        logInlineImageRequest(req, {
          id: inlineId,
          status: 401,
          source: "none",
          bytes: 0,
          mimeType: ""
        });
        res.writeHead(401, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end("Unauthorized");
        return;
      }
      recordHttpUsage(scope, req);

      const memoryEntry = inlineImages.get(inlineId);
      const entry = memoryEntry || await readPersistedInlineImage(inlineId);
      if (!entry) {
        logInlineImageRequest(req, {
          id: inlineId,
          status: 404,
          source: "miss",
          bytes: 0,
          mimeType: ""
        });
        res.writeHead(404, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end("Not found");
        return;
      }

      const etag = `"${entry.id}"`;
      const status = requestCacheIsFresh(req, etag, entry.createdAt) ? 304 : 200;
      logInlineImageRequest(req, {
        id: entry.id,
        status,
        source: memoryEntry ? "memory" : "disk",
        bytes: entry.buffer.length,
        mimeType: entry.mimeType
      });
      sendCachedBuffer(req, res, entry.buffer, entry.mimeType, `"${entry.id}"`, entry.createdAt);
      return;
    }

    if (url.pathname === "/api/upload-image" && req.method === "POST") {
      const scope = scopeFromToken(url.searchParams.get("token"));
      if (!scope) {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      recordHttpUsage(scope, req);

      const rawContentType = String(req.headers["content-type"] || "").split(";")[0].toLowerCase();
      const uploadName = decodeURIComponent(String(req.headers["x-file-name"] || ""));
      const nameMime = imageMimesByExtension.get(path.extname(uploadName).toLowerCase()) || "";
      const contentType = imageExtensionsByMime.has(rawContentType) ? rawContentType : nameMime;
      if (!imageExtensionsByMime.has(contentType)) {
        res.writeHead(415, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Unsupported image type" }));
        return;
      }

      const body = await readRequestBody(req, 15 * 1024 * 1024);
      const targetUploadDir = uploadDirForScope(scope);
      await mkdir(targetUploadDir, { recursive: true });
      const fileName = `${Date.now()}-${randomBytes(8).toString("hex")}${imageExtensionsByMime.get(contentType)}`;
      const filePath = path.join(targetUploadDir, fileName);
      await writeFile(filePath, body);
      sendJson(res, { path: filePath });
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = path.normalize(path.join(publicDir, pathname));
    if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": mimeTypes[ext] || "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message }));
  }
});

const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: {
    threshold: 1024,
    zlibDeflateOptions: { level: 6 },
    zlibInflateOptions: { chunkSize: 16 * 1024 }
  }
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const scope = scopeFromToken(url.searchParams.get("token"));
  if (url.pathname !== "/ws" || !scope) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.tokenScope = scope;
    ws.sendJson = (payload) => {
      const data = JSON.stringify(payload);
      usageTracker.record(scope.id, { bytesOut: Buffer.byteLength(data) });
      ws.send(data);
    };
    usageTracker.record(scope.id, { wsConnections: 1 });
    bridge.attach(ws, scope);
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  ws.on("message", async (data) => {
    const startedAt = performance.now();
    const bytesIn = Buffer.byteLength(data);
    let message;
    try {
      message = JSON.parse(data.toString("utf8"));
    } catch {
      ws.sendJson({ type: "error", error: "Invalid JSON" });
      return;
    }

    try {
      const activeScope = scopeFromToken(ws.tokenScope?.token);
      if (!activeScope || activeScope.id !== ws.tokenScope?.id) {
        ws.close(4001, "Access token was revoked or rotated");
        return;
      }
      ws.tokenScope = activeScope;
      if (message.type === "rpc") {
        await ensureThreadAccess(message.method, message.params || {}, ws.tokenScope);
        const rawResult = await bridge.request(message.method, message.params || {}, ws.tokenScope);
        rememberVisibleThreadFromResult(message.method, rawResult, ws.tokenScope);
        await rememberThreadSettingsFromRpc(message.method, message.params || {}, rawResult);
        const result = await compactResultForClient(message.method, rawResult, ws.tokenScope);
        const response = { type: "rpc-result", requestId: message.requestId, result };
        logRpcServerDebug("result", message, ws.tokenScope, startedAt, bytesIn, response);
        recordRpcUsage(ws.tokenScope, message, bytesIn, response, false);
        ws.sendJson(response);
      } else if (message.type === "server-response") {
        const result = await bridge.respond(message.id, message.result);
        const response = { type: "rpc-result", requestId: message.requestId, result };
        logRpcServerDebug("result", message, ws.tokenScope, startedAt, bytesIn, response);
        recordRpcUsage(ws.tokenScope, message, bytesIn, response, false);
        ws.sendJson(response);
      } else {
        ws.sendJson({ type: "error", requestId: message.requestId, error: "Unknown message type" });
      }
    } catch (error) {
      const response = { type: "rpc-error", requestId: message.requestId, error: error.message };
      logRpcServerDebug("error", message, ws.tokenScope, startedAt, bytesIn, response);
      recordRpcUsage(ws.tokenScope, message, bytesIn, response, true);
      ws.sendJson(response);
    }
  });
});

server.listen(PORT, HOST, async () => {
  const urls = getLanUrls(PORT);
  const banner = [
    "",
    "Codex Mobile Web is running.",
    ...formatTokenUrls("Local", [`http://localhost:${PORT}`]),
    ...formatTokenUrls("LAN", urls),
    "",
    "Open the LAN URL from a phone on the same Wi-Fi.",
    ""
  ].join("\n");
  console.log(banner);

  await printAndWriteQrCodes(urls);

  try {
    const pkg = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
    console.log(`App: ${pkg.name}@${pkg.version}`);
    if (bridge.spawnInfo?.label) console.log(`Codex app-server: ${bridge.spawnInfo.label}`);
  } catch {
    // Best effort only.
  }
});

function sendJson(res, payload) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function recordHttpUsage(scope, req) {
  usageTracker.record(scope?.id, {
    httpRequests: 1,
    bytesIn: Math.max(0, Number(req.headers["content-length"]) || 0)
  });
}

function recordRpcUsage(scope, message, bytesIn, response, failed) {
  usageTracker.record(scope?.id, {
    rpcRequests: 1,
    rpcErrors: failed ? 1 : 0,
    bytesIn,
    method: message?.method || message?.type || "unknown"
  });
}

function logInlineImageRequest(req, detail) {
  const id = String(detail.id || "").slice(0, 48);
  const remote = req.socket?.remoteAddress || "";
  const ua = String(req.headers["user-agent"] || "").slice(0, 120);
  console.log(
    [
      "[inline-image]",
      `status=${detail.status}`,
      `source=${detail.source}`,
      `id=${id || "missing"}`,
      `bytes=${detail.bytes || 0}`,
      `type=${detail.mimeType || "-"}`,
      `remote=${remote || "-"}`,
      `ua=${ua || "-"}`
    ].join(" ")
  );
}

function logRpcServerDebug(event, message, scope, startedAt, bytesIn, response) {
  const method = message?.method || message?.type || "unknown";
  const elapsedMs = Math.round(performance.now() - startedAt);
  const slow = event === "error" || elapsedMs > serverSlowRpcThresholdMs(method);
  if (!slow) return;

  const bytesOut = Buffer.byteLength(JSON.stringify(response || {}));
  console.log(
    JSON.stringify({
      tag: "codex-mobile:rpc",
      event,
      method,
      requestId: message?.requestId,
      elapsedMs,
      bytesIn,
      bytesOut,
      tokenHash: String(scope?.tokenHash || "").slice(0, 10),
      error: response?.error || undefined
    })
  );
}

function serverSlowRpcThresholdMs(method) {
  if (method === "turn/start" || method === "thread/read" || method === "thread/turns/list") return 5000;
  return 2000;
}

function sendCachedFile(req, res, filePath, contentType) {
  const stat = statSync(filePath);
  const etag = fileEtag(stat);
  const lastModified = stat.mtime.toUTCString();
  const headers = {
    "content-type": contentType,
    "content-length": stat.size,
    "cache-control": LOCAL_FILE_CACHE_CONTROL,
    "last-modified": lastModified,
    etag,
    "x-content-type-options": "nosniff"
  };

  if (requestCacheIsFresh(req, etag, stat.mtimeMs)) {
    res.writeHead(304, cacheValidationHeaders(headers));
    res.end();
    return;
  }

  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
}

function sendCachedBuffer(req, res, buffer, contentType, etag, createdAt) {
  const lastModified = new Date(createdAt || Date.now()).toUTCString();
  const headers = {
    "content-type": contentType,
    "content-length": buffer.length,
    "cache-control": INLINE_IMAGE_CACHE_CONTROL,
    "last-modified": lastModified,
    etag,
    "x-content-type-options": "nosniff"
  };

  if (requestCacheIsFresh(req, etag, createdAt)) {
    res.writeHead(304, cacheValidationHeaders(headers));
    res.end();
    return;
  }

  res.writeHead(200, headers);
  res.end(buffer);
}

function requestCacheIsFresh(req, etag, modifiedMs) {
  const ifNoneMatch = String(req.headers["if-none-match"] || "");
  if (ifNoneMatch) {
    return ifNoneMatch
      .split(",")
      .map((value) => value.trim())
      .includes(etag);
  }

  const ifModifiedSince = Date.parse(String(req.headers["if-modified-since"] || ""));
  if (!Number.isFinite(ifModifiedSince)) return false;
  return Math.floor(Number(modifiedMs || 0) / 1000) <= Math.floor(ifModifiedSince / 1000);
}

function cacheValidationHeaders(headers) {
  const next = { ...headers };
  delete next["content-length"];
  return next;
}

function fileEtag(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

function createTokenScopes() {
  const scopes = new Map();
  const envToken = String(process.env.CODEX_MOBILE_TOKEN || "").trim();
  if (envToken) {
    addTokenScope(scopes, envToken, process.env.CODEX_MOBILE_THREAD_FILTER_CWD || "", {
      id: "env-default",
      label: "Environment token"
    });
  }

  const rawScopes = String(process.env.CODEX_MOBILE_TOKEN_SCOPES || "").trim();
  if (rawScopes) {
    let index = 0;
    for (const entry of parseTokenScopeEntries(rawScopes)) {
      index += 1;
      addTokenScope(scopes, entry.token, entry.threadFilterCwds, {
        id: entry.id || `env-${index}`,
        label: entry.label || `Environment token ${index}`
      });
    }
  }

  if (!scopes.size) {
    const store = readTokenStore(dataDir);
    for (const entry of store.tokens) {
      if (entry.disabled) continue;
      addTokenScope(scopes, entry.token, entry.threadFilterCwds, entry);
    }
  }

  if (!scopes.size) throw new Error("No enabled Codex Mobile access tokens are configured.");

  return scopes;
}

function parseTokenScopeEntries(rawScopes) {
  if (!rawScopes) return [];
  try {
    const parsed = JSON.parse(rawScopes);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => ({
        id: String(entry?.id || ""),
        label: String(entry?.label || ""),
        token: String(entry?.token || ""),
        threadFilterCwds: scopePathListFromEntry(entry)
      }));
    }
    if (parsed && typeof parsed === "object") {
      return [{
        id: String(parsed.id || ""),
        label: String(parsed.label || ""),
        token: String(parsed.token || ""),
        threadFilterCwds: scopePathListFromEntry(parsed)
      }];
    }
  } catch {
    // Fall back to token=path;token2=path2 below.
  }

  return rawScopes
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf("=");
      return separator < 0
        ? { token: part, threadFilterCwds: [] }
        : { token: part.slice(0, separator), threadFilterCwds: splitScopePathList(part.slice(separator + 1)) };
    });
}

function addTokenScope(scopes, token, threadFilterCwds, metadata = {}) {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) return;
  const normalizedFilters = splitScopePathList(threadFilterCwds)
    .map((entry) => normalizeLocalPath(entry || ""))
    .filter(Boolean);
  const primaryFilter = normalizedFilters[0] || "";
  scopes.set(normalizedToken, {
    id: String(metadata.id || `token-${scopes.size + 1}`),
    label: String(metadata.label || metadata.id || `Token ${scopes.size + 1}`),
    token: normalizedToken,
    tokenHash: createHash("sha256").update(normalizedToken).digest("hex"),
    threadFilterCwd: primaryFilter,
    threadFilterCwds: normalizedFilters,
    defaultCwd: primaryFilter || DEFAULT_CWD,
    visibleThreadIds: new Set()
  });
}

function scopePathListFromEntry(entry) {
  return splitScopePathList(
    entry?.threadFilterCwds
    || entry?.cwds
    || entry?.threadFilterCwd
    || entry?.cwd
    || ""
  );
}

function splitScopePathList(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  return String(value || "")
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function scopeFromToken(token) {
  refreshTokenScopesIfChanged();
  return tokenScopes.get(String(token || ""));
}

function refreshTokenScopesIfChanged() {
  if (usesEnvironmentTokens) return;
  const modifiedMs = currentTokenStoreModifiedMs();
  if (!modifiedMs || modifiedMs === tokenStoreModifiedMs) return;
  const nextScopes = createTokenScopes();
  tokenScopes = nextScopes;
  defaultTokenScope = nextScopes.values().next().value;
  tokenStoreModifiedMs = modifiedMs;
  console.log(`[tokens] Reloaded ${tokenScopes.size} enabled token(s).`);
}

function currentTokenStoreModifiedMs() {
  try {
    return statSync(tokenStorePath(dataDir)).mtimeMs;
  } catch {
    return 0;
  }
}

function uploadDirForScope(scope) {
  return path.join(uploadDir, String(scope?.id || "default").replace(/[^a-zA-Z0-9_-]/g, "-"));
}

function isLocalFileAccessible(scope, requestedPath) {
  if (!isLocalImagePath(requestedPath)) return false;
  if (!hasThreadFilter(scope)) return true;
  const roots = [
    rootDir,
    uploadDirForScope(scope),
    scope?.defaultCwd,
    ...scopeFilterRoots(scope)
  ]
    .map((entry) => normalizeLocalPath(entry || ""))
    .filter(Boolean);
  return roots.some((root) => isPathInside(root, requestedPath));
}

function isLocalImagePath(value) {
  const ext = path.extname(normalizeLocalPath(value || "")).toLowerCase();
  return imageMimesByExtension.has(ext) || ext === ".svg";
}

function formatTokenUrls(label, baseUrls) {
  const lines = [];
  for (const scope of tokenScopes.values()) {
    const filters = scopeFilterRoots(scope);
    const filterLabel = filters.length ? `  Filter: ${filters.join(" | ")}` : "";
    for (const baseUrl of baseUrls) {
      lines.push(`${label} [${scope.id}]: ${baseUrl}/?token=${scope.token}${filterLabel}`);
    }
  }
  return lines;
}

async function printAndWriteQrCodes(baseUrls) {
  const primaryBaseUrl = baseUrls[0];
  if (!primaryBaseUrl) return;
  const qrDir = path.join(dataDir, "qr");
  await mkdir(qrDir, { recursive: true });
  let first = true;
  for (const scope of tokenScopes.values()) {
    const url = `${primaryBaseUrl}/?token=${encodeURIComponent(scope.token)}`;
    const qrPath = path.join(qrDir, `${scope.id.replace(/[^a-zA-Z0-9_-]/g, "-")}.svg`);
    await QRCode.toFile(qrPath, url, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
    console.log(`QR [${scope.id}]: ${qrPath}`);
    if (first && process.env.CODEX_MOBILE_TERMINAL_QR !== "0") {
      console.log(`\nScan to open ${scope.label}:\n`);
      console.log(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
      first = false;
    }
  }
}

async function compactResultForClient(method, result, scope = defaultTokenScope) {
  if (method === "thread/list") return filterThreadListResult(result, scope);
  if (method === "thread/read") return enrichThreadReadResult(stripInlineDataImages(result));
  if (method === "thread/start" || method === "thread/resume") {
    return enrichThreadResult(result);
  }
  if (method === "thread/turns/list") return stripInlineDataImages(result);
  return result;
}


function filterThreadListResult(result, scope = defaultTokenScope) {
  if (!result || !Array.isArray(result.data)) return result;
  if (!hasThreadFilter(scope)) {
    for (const thread of result.data) {
      if (thread?.id) scope.visibleThreadIds.add(thread.id);
    }
    return result;
  }
  const data = result.data.filter((thread) => isThreadInFilter(thread, scope));
  scope.visibleThreadIds.clear();
  for (const thread of data) {
    if (thread?.id) scope.visibleThreadIds.add(thread.id);
  }
  return { ...result, data };
}

function rememberVisibleThreadFromResult(method, result, scope = defaultTokenScope) {
  if (!hasThreadFilter(scope)) return;
  if (method !== "thread/start" && method !== "thread/resume" && method !== "thread/read") return;
  const thread = result?.thread || result;
  if (thread?.id && isThreadInFilter(thread, scope)) {
    scope.visibleThreadIds.add(thread.id);
  }
}

async function ensureThreadAccess(method, params, scope = defaultTokenScope) {
  if (!hasThreadFilter(scope) || method === "thread/list" || method === "thread/start") return;
  const threadId = threadIdFromParams(params);
  if (!threadId) return;
  if (scope.visibleThreadIds.has(threadId)) return;

  const result = await bridge.request("thread/read", { threadId }, scope);
  const thread = result?.thread || result;
  if (thread?.id && isThreadInFilter(thread, scope)) {
    scope.visibleThreadIds.add(thread.id);
    return;
  }
  throw new Error("This token can only access sessions in the allowed folder.");
}

function threadIdFromParams(params) {
  return params?.threadId || params?.thread_id || params?.id || "";
}

function isThreadInFilter(thread, scope = defaultTokenScope) {
  const cwd = normalizeLocalPath(thread?.cwd || "");
  return Boolean(cwd && isPathAllowedInScope(scope, cwd));
}

function hasThreadFilter(scope) {
  return scopeFilterRoots(scope).length > 0;
}

function scopeFilterRoots(scope) {
  if (Array.isArray(scope?.threadFilterCwds) && scope.threadFilterCwds.length) {
    return scope.threadFilterCwds;
  }
  return scope?.threadFilterCwd ? [scope.threadFilterCwd] : [];
}

function isPathAllowedInScope(scope, value) {
  const target = normalizeLocalPath(value || "");
  return Boolean(target && scopeFilterRoots(scope).some((root) => isPathInside(root, target)));
}

async function enrichThreadReadResult(result) {
  if (!result?.thread) return result;
  return { ...result, thread: await enrichThreadWithPermissionSettings(result.thread) };
}

async function enrichThreadResult(result) {
  if (!result?.thread) return result;
  return { ...result, thread: await enrichThreadWithPermissionSettings(result.thread) };
}

async function enrichThreadWithPermissionSettings(thread) {
  if (!thread?.id) return thread;
  const permissionSettings = await readThreadPermissionSettings(thread);
  return permissionSettings ? { ...thread, permissionSettings } : thread;
}

async function readThreadPermissionSettings(thread) {
  const fromContext = await readLatestTurnContextPermissions(thread.path);
  if (fromContext) return fromContext;

  const store = await loadThreadSettingsStore();
  const fromStore = store?.[thread.id];
  return fromStore ? { ...fromStore, source: fromStore.source || "sidecar" } : null;
}

async function readLatestTurnContextPermissions(sessionPath) {
  const resolvedPath = normalizeLocalPath(sessionPath || "");
  if (!resolvedPath || !existsSync(resolvedPath)) return null;

  try {
    const lines = (await readFile(resolvedPath, "utf8")).trim().split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const record = JSON.parse(lines[index]);
      if (record?.type !== "turn_context") continue;
      return permissionSettingsFromTurnContext(record.payload || {}, record.timestamp);
    }
  } catch {
    return null;
  }

  return null;
}

function permissionSettingsFromTurnContext(payload, timestamp = null) {
  const sandbox = payload.sandbox_policy?.type || "";
  return {
    approvalPolicy: payload.approval_policy || "",
    sandbox,
    cwd: payload.cwd || "",
    model: payload.model || "",
    reasoningEffort: payload.effort || "",
    networkAccess: payload.sandbox_policy?.network_access ?? null,
    source: "turn_context",
    updatedAt: timestamp
  };
}

async function rememberThreadSettingsFromRpc(method, params, result) {
  if (method !== "thread/start" && method !== "thread/resume") return;
  const threadId = result?.thread?.id || result?.id;
  if (!threadId) return;

  const store = await loadThreadSettingsStore();
  const previous = store[threadId] || {};
  const settings = {
    approvalPolicy: settingValue(
      params,
      "approvalPolicy",
      method === "thread/start" ? "on-request" : previous.approvalPolicy
    ),
    sandbox: settingValue(
      params,
      "sandbox",
      method === "thread/start" ? "workspace-write" : previous.sandbox
    ),
    cwd: settingValue(params, "cwd", result?.thread?.cwd || previous.cwd),
    model: settingValue(params, "model", previous.model),
    reasoningEffort: reasoningEffortFromParams(params, previous.reasoningEffort),
    source: "sidecar",
    updatedAt: new Date().toISOString()
  };

  store[threadId] = settings;
  await writeThreadSettingsStore(store);
}

function normalizeReasoningEffortParam(params) {
  if (!params) return;
  if (!Object.prototype.hasOwnProperty.call(params, "effort") && params.reasoningEffort) {
    params.effort = params.reasoningEffort;
  }
  delete params.reasoningEffort;
  if (params.effort === "") delete params.effort;
}

function settingValue(params, key, fallback = "") {
  return Object.prototype.hasOwnProperty.call(params || {}, key) ? params[key] || "" : fallback || "";
}

function reasoningEffortFromParams(params, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(params || {}, "effort")) return params.effort || "";
  if (Object.prototype.hasOwnProperty.call(params || {}, "reasoningEffort")) {
    return params.reasoningEffort || "";
  }
  return fallback || "";
}

async function loadThreadSettingsStore() {
  if (threadSettingsStore) return threadSettingsStore;
  try {
    threadSettingsStore = JSON.parse(await readFile(threadSettingsStorePath, "utf8"));
  } catch {
    threadSettingsStore = {};
  }
  return threadSettingsStore;
}

async function writeThreadSettingsStore(store) {
  threadSettingsStore = store || {};
  await writeFile(threadSettingsStorePath, `${JSON.stringify(threadSettingsStore, null, 2)}\n`, "utf8");
}

function stripInlineDataImages(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripInlineDataImages);

  const next = {};
  const isImageGeneration = value.type === "imageGeneration";
  for (const [key, entry] of Object.entries(value)) {
    if (key === "url" && typeof entry === "string" && entry.startsWith("data:image/")) {
      const inline = rememberInlineImage(entry);
      next.url = "";
      next.omittedBytes = Buffer.byteLength(entry);
      next.omittedReason = "inline image hidden";
      if (inline) {
        next.inlineImageId = inline.id;
        next.mimeType = inline.mimeType;
      }
    } else if (isImageGeneration && key === "result" && typeof entry === "string" && looksLikeBase64Image(entry)) {
      const inline = rememberInlineImagePayload(entry);
      next.result = "";
      next.omittedBytes = Buffer.byteLength(entry);
      next.omittedReason = "inline image hidden";
      if (inline) {
        next.inlineImageId = inline.id;
        next.mimeType = inline.mimeType;
      }
    } else {
      next[key] = stripInlineDataImages(entry);
    }
  }
  return next;
}

function rememberInlineImage(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  const [, mimeType, base64] = match;
  return rememberInlineImagePayload(base64, mimeType);
}

function rememberInlineImagePayload(base64, mimeType = imageMimeFromBase64(base64)) {
  if (!base64 || !mimeType) return null;
  const id = createHash("sha256").update(`${mimeType}:${base64}`).digest("base64url");
  if (!inlineImages.has(id)) {
    const entry = {
      id,
      mimeType,
      buffer: Buffer.from(base64, "base64"),
      createdAt: Date.now()
    };
    inlineImages.set(id, entry);
    trimInlineImageMemory();
    persistInlineImage(entry);
  }
  return { id, mimeType };
}

function trimInlineImageMemory() {
  while (inlineImages.size > inlineImageLimit) {
    const oldest = inlineImages.keys().next().value;
    inlineImages.delete(oldest);
  }
}

function persistInlineImage(entry) {
  const ext = imageExtensionsByMime.get(entry.mimeType);
  if (!ext || !isSafeInlineImageId(entry.id)) return;

  try {
    mkdirSync(inlineImageDir, { recursive: true });
    const filePath = path.join(inlineImageDir, `${entry.id}${ext}`);
    if (existsSync(filePath)) return;
    writeFile(filePath, entry.buffer).catch(() => {});
  } catch {
    // In-memory serving still works when disk persistence is unavailable.
  }
}

async function readPersistedInlineImage(id) {
  if (!isSafeInlineImageId(id)) return null;

  for (const [mimeType, ext] of imageExtensionsByMime) {
    const filePath = path.join(inlineImageDir, `${id}${ext}`);
    if (!existsSync(filePath)) continue;
    try {
      const buffer = await readFile(filePath);
      const entry = {
        id,
        mimeType,
        buffer,
        createdAt: statSync(filePath).mtimeMs
      };
      inlineImages.set(id, entry);
      trimInlineImageMemory();
      return entry;
    } catch {
      return null;
    }
  }

  return null;
}

function isSafeInlineImageId(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id || ""));
}

function looksLikeBase64Image(value) {
  if (typeof value !== "string" || value.length < 80) return false;
  return Boolean(imageMimeFromBase64(value));
}

function imageMimeFromBase64(value) {
  if (value.startsWith("iVBORw0KGgo")) return "image/png";
  if (value.startsWith("/9j/")) return "image/jpeg";
  if (value.startsWith("R0lGOD")) return "image/gif";
  if (value.startsWith("UklGR")) return "image/webp";
  return "";
}

function getLanUrls(port) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return urls.length ? urls : [`http://localhost:${port}`];
}

function normalizeLocalPath(value) {
  if (!value) return "";
  let next = value;
  if (/^\/[a-zA-Z]:\//.test(next)) {
    next = next.slice(1);
  }
  return path.resolve(next);
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readRequestBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Upload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function stopBridge() {
  if (!bridge.proc?.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(bridge.proc.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
  } else {
    bridge.proc.kill();
  }
}

process.on("SIGINT", () => {
  usageTracker.flush();
  stopBridge();
  process.exit(0);
});

process.on("SIGTERM", () => {
  usageTracker.flush();
  stopBridge();
  process.exit(0);
});
