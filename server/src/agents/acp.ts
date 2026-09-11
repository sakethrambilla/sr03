// A small newline-delimited JSON-RPC 2.0 client over a child process's stdio. It bounds protocol
// lines and diagnostics, serializes writes, and settles every pending call when the child ends.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface AcpRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type AcpRequestHandler = (params: unknown) => unknown | Promise<unknown>;
export type AcpNotificationHandler = (params: unknown) => void | Promise<void>;

export interface AcpSpawnOptions {
  binary: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  // Cursor ACP requires the JSON-RPC 2.0 field; Codex app-server omits it.
  jsonrpc?: boolean;
  // Prefix for transport errors and stderr tails. Defaults to "ACP".
  label?: string;
  maxLineBytes?: number;
  maxDiagnosticBytes?: number;
  onStderr?: (text: string) => void;
  onDiagnostic?: (message: string) => void;
  onClose?: (error: Error | null) => void;
}

export interface AcpConnection {
  readonly pid: number | undefined;
  readonly closed: boolean;
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: AcpRequestOptions,
  ): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  registerRequestHandler(method: string, handler: AcpRequestHandler): () => void;
  registerNotificationHandler(method: string, handler: AcpNotificationHandler): () => void;
  close(): void;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
}

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc?: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

type OutboundMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

function withJsonrpc<T extends OutboundMessage>(include: boolean, message: T): T {
  if (!include) return message;
  return { jsonrpc: "2.0", ...message };
}

const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;

export class AcpRpcError extends Error {
  code: number;
  data: unknown;
  method: string | undefined;

  constructor(message: string, code: number, data?: unknown, method?: string) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
    this.method = method;
  }
}

export class AcpTransportError extends Error {
  cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AcpTransportError";
    this.cause = cause;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function idKey(id: JsonRpcId): string {
  return `${id === null ? "null" : typeof id}:${String(id)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function boundedTail(value: string, limit: number): string {
  if (Buffer.byteLength(value) <= limit) return value;
  const bytes = Buffer.from(value);
  return bytes.subarray(Math.max(0, bytes.length - limit)).toString("utf8");
}

function boundedPreview(value: Buffer, limit: number): string {
  const preview = value.subarray(0, Math.min(value.length, limit)).toString("utf8");
  return value.length > limit ? `${preview}…` : preview;
}

function rpcError(value: unknown, method: string): AcpRpcError {
  if (!isRecord(value)) {
    return new AcpRpcError(`ACP request "${method}" failed`, -32000, value, method);
  }
  const code = typeof value.code === "number" ? value.code : -32000;
  const message =
    typeof value.message === "string" && value.message.trim()
      ? value.message
      : `ACP request "${method}" failed`;
  return new AcpRpcError(message, code, value.data, method);
}

function positionalOptions(
  binaryOrOptions: string | AcpSpawnOptions,
  args?: readonly string[],
  cwd?: string,
  extras?: Omit<AcpSpawnOptions, "binary" | "args" | "cwd">,
): AcpSpawnOptions {
  if (typeof binaryOrOptions !== "string") return binaryOrOptions;
  if (!args || !cwd) throw new Error("spawnAcp requires binary, args, and cwd");
  return { binary: binaryOrOptions, args, cwd, ...extras };
}

export function spawnAcp(options: AcpSpawnOptions): AcpConnection;
export function spawnAcp(
  binary: string,
  args: readonly string[],
  cwd: string,
  options?: Omit<AcpSpawnOptions, "binary" | "args" | "cwd">,
): AcpConnection;
export function spawnAcp(
  binaryOrOptions: string | AcpSpawnOptions,
  positionalArgs?: readonly string[],
  positionalCwd?: string,
  positionalExtras?: Omit<AcpSpawnOptions, "binary" | "args" | "cwd">,
): AcpConnection {
  const options = positionalOptions(
    binaryOrOptions,
    positionalArgs,
    positionalCwd,
    positionalExtras,
  );
  const maxLineBytes = positiveLimit(options.maxLineBytes, DEFAULT_MAX_LINE_BYTES);
  const maxDiagnosticBytes = positiveLimit(
    options.maxDiagnosticBytes,
    DEFAULT_MAX_DIAGNOSTIC_BYTES,
  );
  const includeJsonrpc = options.jsonrpc !== false;
  const label = options.label?.trim() || "ACP";
  const child: ChildProcessWithoutNullStreams = spawn(options.binary, [...options.args], {
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<string, PendingRequest>();
  const requestHandlers = new Map<string, AcpRequestHandler>();
  const notificationHandlers = new Map<string, AcpNotificationHandler>();
  let stdoutBuffer = Buffer.alloc(0);
  let stderrTail = "";
  let nextRequestId = 1;
  let ended = false;
  let writeTail: Promise<void> = Promise.resolve();
  let forceKillTimer: NodeJS.Timeout | null = null;

  function diagnostic(message: string): void {
    try {
      options.onDiagnostic?.(boundedTail(message, maxDiagnosticBytes));
    } catch {
      // Diagnostics must never interfere with protocol handling.
    }
  }

  function withStderr(message: string): string {
    const stderr = stderrTail.trim();
    return stderr ? `${message}\n${label} stderr:\n${stderr}` : message;
  }

  function cleanupPending(entry: PendingRequest): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.signal && entry.abort) entry.signal.removeEventListener("abort", entry.abort);
  }

  function rejectPending(error: Error): void {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      cleanupPending(entry);
      entry.reject(error);
    }
  }

  function killChild(): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may have exited between the state check and kill.
        }
      }
    }, FORCE_KILL_DELAY_MS);
    forceKillTimer.unref();
  }

  function finish(error: Error, intentional: boolean, kill: boolean): void {
    if (ended) return;
    ended = true;
    stdoutBuffer = Buffer.alloc(0);
    rejectPending(error);
    if (kill) killChild();
    try {
      options.onClose?.(intentional ? null : error);
    } catch {
      // Session cleanup must not depend on observer behavior.
    }
  }

  function transportFailure(message: string, cause?: unknown): AcpTransportError {
    return new AcpTransportError(withStderr(message), cause);
  }

  function writeNow(line: string): Promise<void> {
    if (ended) return Promise.reject(new AcpTransportError(`${label} connection is closed`));
    if (!child.stdin.writable || child.stdin.destroyed) {
      return Promise.reject(transportFailure(`${label} stdin is not writable`));
    }
    return new Promise<void>((resolve, reject) => {
      try {
        child.stdin.write(line, "utf8", (error) => {
          if (error) {
            const failure = transportFailure(`Failed to write to ${label} stdin`, error);
            finish(failure, false, true);
            reject(failure);
            return;
          }
          if (ended) {
            reject(new AcpTransportError(`${label} connection closed while writing`));
            return;
          }
          resolve();
        });
      } catch (error) {
        const failure = transportFailure(`Failed to write to ${label} stdin`, error);
        finish(failure, false, true);
        reject(failure);
      }
    });
  }

  function sendMessage(message: OutboundMessage) {
    let encoded: string;
    try {
      const value = JSON.stringify(message);
      if (typeof value !== "string") throw new TypeError("Message is not JSON serializable");
      encoded = `${value}\n`;
    } catch (error) {
      return Promise.reject(new AcpTransportError(`Failed to encode ${label} JSON-RPC message`, error));
    }
    if (Buffer.byteLength(encoded) > maxLineBytes) {
      return Promise.reject(
        new AcpTransportError(`Outbound ${label} JSON-RPC message exceeds ${maxLineBytes} bytes`),
      );
    }
    const write = writeTail.then(() => writeNow(encoded));
    writeTail = write.catch(() => undefined);
    return write;
  }

  function sendFailure(id: JsonRpcId, error: JsonRpcErrorObject): Promise<void> {
    return sendMessage(withJsonrpc(includeJsonrpc, { id, error }));
  }

  function settleResponse(message: Record<string, unknown>): void {
    const id = message.id;
    if (id !== null && typeof id !== "number" && typeof id !== "string") return;
    const key = idKey(id);
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    cleanupPending(entry);
    if (hasOwn(message, "error")) {
      entry.reject(rpcError(message.error, entry.method));
      return;
    }
    entry.resolve(message.result);
  }

  async function handleIncomingRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): Promise<void> {
    const handler = requestHandlers.get(method);
    if (!handler) {
      await sendFailure(id, { code: -32601, message: `Method not found: ${method}` }).catch(
        () => undefined,
      );
      return;
    }
    try {
      const result = await handler(params);
      await sendMessage(
        withJsonrpc(includeJsonrpc, { id, result: result === undefined ? null : result }),
      );
    } catch (error) {
      const failure =
        error instanceof AcpRpcError
          ? {
              code: error.code,
              message: error.message,
              ...(error.data === undefined ? {} : { data: error.data }),
            }
          : { code: -32603, message: "Internal error" };
      diagnostic(`${label} request handler "${method}" failed: ${errorMessage(error)}`);
      await sendFailure(id, failure).catch(() => undefined);
    }
  }

  function handleNotification(method: string, params: unknown): void {
    const handler = notificationHandlers.get(method);
    if (!handler) return;
    void Promise.resolve()
      .then(() => handler(params))
      .catch((error) =>
        diagnostic(`${label} notification handler "${method}" failed: ${errorMessage(error)}`),
      );
  }

  function handleMessage(value: unknown): void {
    if (!isRecord(value) || (includeJsonrpc && value.jsonrpc !== "2.0")) {
      const failure = transportFailure(`${label} emitted an invalid JSON-RPC envelope`);
      finish(failure, false, true);
      return;
    }

    if (typeof value.method === "string") {
      if (!hasOwn(value, "id")) {
        handleNotification(value.method, value.params);
        return;
      }
      const id = value.id;
      if (id !== null && typeof id !== "number" && typeof id !== "string") {
        void sendFailure(null, { code: -32600, message: "Invalid Request" }).catch(
          () => undefined,
        );
        return;
      }
      void handleIncomingRequest(id, value.method, value.params);
      return;
    }

    if (
      hasOwn(value, "id") &&
      (hasOwn(value, "result") || hasOwn(value, "error"))
    ) {
      settleResponse(value);
      return;
    }

    const failure = transportFailure(`${label} emitted an unrecognized JSON-RPC message`);
    finish(failure, false, true);
  }

  function handleLine(line: Buffer): void {
    if (line.length > maxLineBytes) {
      const failure = transportFailure(
        `${label} output line exceeds ${maxLineBytes} bytes: ${boundedPreview(
          line,
          maxDiagnosticBytes,
        )}`,
      );
      finish(failure, false, true);
      return;
    }
    const withoutCarriageReturn =
      line.length > 0 && line[line.length - 1] === 13 ? line.subarray(0, -1) : line;
    if (withoutCarriageReturn.length === 0) return;
    try {
      handleMessage(JSON.parse(withoutCarriageReturn.toString("utf8")) as unknown);
    } catch (error) {
      const failure = transportFailure(
        `Failed to parse ${label} JSON-RPC output: ${boundedPreview(
          withoutCarriageReturn,
          maxDiagnosticBytes,
        )}`,
        error,
      );
      finish(failure, false, true);
    }
  }

  child.stdout.on("data", (chunk: Buffer | string) => {
    if (ended) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    stdoutBuffer =
      stdoutBuffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([stdoutBuffer, bytes]);
    while (!ended) {
      const newline = stdoutBuffer.indexOf(10);
      if (newline < 0) break;
      const line = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      handleLine(line);
    }
    if (!ended && stdoutBuffer.length > maxLineBytes) {
      const failure = transportFailure(
        `${label} output line exceeds ${maxLineBytes} bytes: ${boundedPreview(
          stdoutBuffer,
          maxDiagnosticBytes,
        )}`,
      );
      finish(failure, false, true);
    }
  });

  child.stdout.on("error", (error) => {
    finish(transportFailure(`Failed to read ${label} stdout`, error), false, true);
  });

  child.stdout.on("end", () => {
    if (ended) return;
    if (stdoutBuffer.length > 0) handleLine(stdoutBuffer);
    if (!ended) {
      finish(transportFailure(`${label} stdout ended unexpectedly`), false, true);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const bounded = boundedTail(chunk, maxDiagnosticBytes);
    stderrTail = boundedTail(`${stderrTail}${bounded}`, maxDiagnosticBytes);
    try {
      options.onStderr?.(bounded);
    } catch {
      // Logging callbacks are observational only.
    }
  });
  child.stderr.on("error", (error) => {
    diagnostic(`Failed to read ${label} stderr: ${errorMessage(error)}`);
  });

  child.stdin.on("error", (error) => {
    finish(transportFailure(`${label} stdin failed`, error), false, true);
  });

  child.on("error", (error) => {
    finish(transportFailure(`Failed to spawn ${label} process "${options.binary}"`, error), false, false);
  });

  child.on("exit", (code, signal) => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
    }
    if (ended) return;
    const detail =
      code === null
        ? `${label} process exited from signal ${signal ?? "unknown"}`
        : `${label} process exited with code ${code}`;
    finish(transportFailure(detail), false, false);
  });

  function allocateRequestId(): number {
    const id = nextRequestId;
    nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
    return id;
  }

  function request<T = unknown>(
    method: string,
    params?: unknown,
    requestOptions?: AcpRequestOptions,
  ): Promise<T> {
    if (ended) return Promise.reject(new AcpTransportError(`${label} connection is closed`));
    if (!method.trim()) return Promise.reject(new TypeError(`${label} request method is required`));
    if (requestOptions?.signal?.aborted) {
      return Promise.reject(new AcpTransportError(`${label} request "${method}" was aborted`));
    }
    const id = allocateRequestId();
    const key = idKey(id);
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer: null,
        signal: requestOptions?.signal,
        abort: undefined,
      };

      if (
        typeof requestOptions?.timeoutMs === "number" &&
        Number.isFinite(requestOptions.timeoutMs) &&
        requestOptions.timeoutMs > 0
      ) {
        entry.timer = setTimeout(() => {
          if (!pending.delete(key)) return;
          cleanupPending(entry);
          reject(
            new AcpTransportError(
              `${label} request "${method}" timed out after ${requestOptions.timeoutMs}ms`,
            ),
          );
        }, requestOptions.timeoutMs);
        entry.timer.unref();
      }

      if (entry.signal) {
        entry.abort = () => {
          if (!pending.delete(key)) return;
          cleanupPending(entry);
          reject(new AcpTransportError(`${label} request "${method}" was aborted`));
        };
        entry.signal.addEventListener("abort", entry.abort, { once: true });
      }

      pending.set(key, entry);
      void sendMessage(
        withJsonrpc(includeJsonrpc, {
          id,
          method,
          ...(params === undefined ? {} : { params }),
        }),
      ).catch((error) => {
        if (!pending.delete(key)) return;
        cleanupPending(entry);
        reject(
          error instanceof Error
            ? error
            : new AcpTransportError(`Failed to send ${label} request "${method}"`, error),
        );
      });
    });
  }

  function notify(method: string, params?: unknown): Promise<void> {
    if (!method.trim()) return Promise.reject(new TypeError(`${label} notification method is required`));
    return sendMessage(
      withJsonrpc(includeJsonrpc, {
        method,
        ...(params === undefined ? {} : { params }),
      }),
    );
  }

  function registerRequestHandler(method: string, handler: AcpRequestHandler): () => void {
    requestHandlers.set(method, handler);
    return () => {
      if (requestHandlers.get(method) === handler) requestHandlers.delete(method);
    };
  }

  function registerNotificationHandler(
    method: string,
    handler: AcpNotificationHandler,
  ): () => void {
    notificationHandlers.set(method, handler);
    return () => {
      if (notificationHandlers.get(method) === handler) notificationHandlers.delete(method);
    };
  }

  function close(): void {
    if (ended) return;
    const error = new AcpTransportError(`${label} connection was closed`);
    try {
      child.stdin.end();
    } catch {
      // Killing the child below is the final fallback.
    }
    finish(error, true, true);
  }

  return {
    get pid() {
      return child.pid;
    },
    get closed() {
      return ended;
    },
    request,
    notify,
    registerRequestHandler,
    registerNotificationHandler,
    close,
  };
}

export const createAcpConnection = spawnAcp;
