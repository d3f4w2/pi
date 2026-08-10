export const WORKER_PREFIX = "\u001ePI_EVAL:";

export const PYTHON_WORKER = String.raw`
import ast, asyncio, contextlib, inspect, io, json, sys, traceback

PREFIX = "\u001ePI_EVAL:"
loop = asyncio.new_event_loop()
current_request_id = None
current_nonce = None
next_tool_call_id = 1

def safe_repr(value):
    try:
        return repr(value)
    except Exception as error:
        return "<repr failed: %s>" % error

def pi_tool(name, **args):
    global next_tool_call_id
    if current_request_id is None or current_nonce is None:
        raise RuntimeError("pi_tool can only run inside an Eval code cell")
    call_id = next_tool_call_id
    next_tool_call_id += 1
    message = {"type": "tool_call", "id": current_request_id, "callId": call_id, "nonce": current_nonce, "tool": name, "args": args}
    sys.__stdout__.write(PREFIX + json.dumps(message, ensure_ascii=False) + "\n")
    sys.__stdout__.flush()
    raw_response = sys.stdin.readline()
    if not raw_response:
        raise RuntimeError("pi_tool bridge closed")
    response = json.loads(raw_response)
    if response.get("type") != "tool_result" or response.get("callId") != call_id:
        raise RuntimeError("pi_tool received an invalid bridge response")
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "pi_tool failed"))
    return response.get("result", "")

namespace = {"__name__": "__pi_eval__", "pi_tool": pi_tool}

sys.__stdout__.write(PREFIX + json.dumps({"type": "ready"}) + "\n")
sys.__stdout__.flush()

for raw in sys.stdin:
    try:
        request = json.loads(raw)
        request_id = request.get("id")
        current_request_id = request_id
        current_nonce = request.get("nonce")
        code = request.get("code", "")
        stdout = io.StringIO()
        stderr = io.StringIO()
        try:
            tree = ast.parse(code, "<pi-eval>", "exec")
            result_name = "__pi_last_result__"
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                tree.body[-1] = ast.Assign(targets=[ast.Name(id=result_name, ctx=ast.Store())], value=tree.body[-1].value)
                ast.fix_missing_locations(tree)
            compiled = compile(tree, "<pi-eval>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                pending = eval(compiled, namespace, namespace)
                if inspect.isawaitable(pending):
                    loop.run_until_complete(pending)
            value = namespace.pop(result_name, None)
            response = {"id": request_id, "ok": True, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "value": safe_repr(value)}
        except BaseException:
            response = {"id": request_id, "ok": False, "stdout": stdout.getvalue(), "stderr": stderr.getvalue(), "error": traceback.format_exc(limit=12)}
    except BaseException:
        response = {"id": None, "ok": False, "stdout": "", "stderr": "", "error": traceback.format_exc(limit=6)}
    sys.__stdout__.write(PREFIX + json.dumps(response, ensure_ascii=False) + "\n")
    sys.__stdout__.flush()
`;

export const BUN_WORKER = String.raw`
import vm from "node:vm";
import readline from "node:readline";
import util from "node:util";

const PREFIX = "\u001ePI_EVAL:";
const sandbox = {
  Buffer,
  Bun,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  clearInterval,
  clearTimeout,
  fetch,
  setInterval,
  setTimeout,
};
const context = vm.createContext(sandbox);
const protocol = process.stdout;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
let currentRequest;
let nextToolCallId = 1;

async function piTool(name, args = {}) {
  if (!currentRequest) throw new Error("piTool can only run inside an Eval code cell");
  const callId = nextToolCallId++;
  protocol.write(PREFIX + JSON.stringify({ type: "tool_call", id: currentRequest.id, callId, nonce: currentRequest.nonce, tool: name, args }) + "\n");
  const next = await input.next();
  if (next.done) throw new Error("piTool bridge closed");
  const response = JSON.parse(next.value);
  if (response.type !== "tool_result" || response.callId !== callId) throw new Error("piTool received an invalid bridge response");
  if (!response.ok) throw new Error(response.error ?? "piTool failed");
  return response.result ?? "";
}
sandbox.piTool = piTool;
protocol.write(PREFIX + JSON.stringify({ type: "ready" }) + "\n");

for (;;) {
  const next = await input.next();
  if (next.done) break;
  const raw = next.value;
  let request;
  try {
    request = JSON.parse(raw);
    currentRequest = request;
    const stdout = [];
    const stderr = [];
    context.console = {
      log: (...values) => stdout.push(values.map((value) => util.inspect(value, { depth: 5, colors: false })).join(" ")),
      info: (...values) => stdout.push(values.map((value) => util.inspect(value, { depth: 5, colors: false })).join(" ")),
      warn: (...values) => stderr.push(values.map((value) => util.inspect(value, { depth: 5, colors: false })).join(" ")),
      error: (...values) => stderr.push(values.map((value) => util.inspect(value, { depth: 5, colors: false })).join(" ")),
    };
    let value;
    try {
      value = vm.runInContext(request.code, context, { filename: "<pi-eval>" });
    } catch (error) {
      if (!error || typeof error !== "object" || error.name !== "SyntaxError") throw error;
      value = vm.runInContext("(async () => { " + request.code + "\n})()", context, { filename: "<pi-eval>" });
    }
    if (value && typeof value.then === "function") value = await value;
    protocol.write(PREFIX + JSON.stringify({ id: request.id, ok: true, stdout: stdout.join("\n"), stderr: stderr.join("\n"), value: util.inspect(value, { depth: 6, colors: false }) }) + "\n");
  } catch (error) {
    protocol.write(PREFIX + JSON.stringify({ id: request?.id, ok: false, stdout: "", stderr: "", error: error instanceof Error ? error.stack ?? error.message : String(error) }) + "\n");
  } finally {
    currentRequest = undefined;
  }
}
`;
