import { spawn } from "node:child_process";
import readline from "node:readline";

const [mode = "allow", existingSessionId] = process.argv.slice(2);
const cwd = process.cwd();
const child = spawn("cursor", ["agent", "acp"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let nextId = 1;
let sessionId = existingSessionId;
let cancelled = false;

function emit(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

function send(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function respond(id, result) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const timer = setTimeout(() => {
  emit("timeout", { mode });
  child.kill();
}, 45_000);

const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    emit("protocol_error");
    return;
  }
  if (message.id && (message.result || message.error)) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(message.error) : waiter.resolve(message.result);
    return;
  }
  if (message.method === "session/request_permission") {
    const optionId = mode === "deny" ? "reject-once" : "allow-once";
    emit("permission_request", { decision: optionId });
    respond(message.id, { outcome: { outcome: "selected", optionId } });
  }
});

child.stderr.on("data", () => emit("stderr"));
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  emit("exit", { code, signal });
});

try {
  const initialized = await send("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "faktori-feasibility", version: "0.1.0" },
  });
  emit("initialized", { loadSession: initialized.agentCapabilities?.loadSession === true });
  await send("authenticate", { methodId: "cursor_login" });
  emit("authenticated");
  if (sessionId) {
    await send("session/load", { sessionId, cwd, mcpServers: [] });
    emit("session_loaded", { sessionId });
  } else {
    const created = await send("session/new", { cwd, mcpServers: [] });
    sessionId = created.sessionId;
    emit("session_created", { sessionId });
  }
  const prompt = mode === "cancel"
    ? "Work slowly and describe one hundred prime numbers. Do not read or write files."
    : "Create only cursor-scratch.txt in the current directory with exactly: cursor feasibility ok. Do not access any other paths or network resources.";
  const promptResult = send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: prompt }],
  });
  if (mode === "cancel") {
    setTimeout(() => {
      if (!cancelled) {
        cancelled = true;
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })}\n`);
        emit("cancel_sent", { sessionId });
      }
    }, 1_000);
  }
  const finished = await promptResult;
  emit("prompt_finished", { stopReason: finished.stopReason ?? "unknown", sessionId });
} catch (error) {
  emit("error", { kind: typeof error?.message === "string" ? "request_failed" : "unknown" });
} finally {
  child.stdin.end();
  setTimeout(() => child.kill(), 250);
}
