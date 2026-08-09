export const WORKER_PREFIX = "\u001ePI_EVAL:";

export const PYTHON_WORKER = String.raw`
import ast, asyncio, contextlib, inspect, io, json, sys, traceback

PREFIX = "\u001ePI_EVAL:"
namespace = {"__name__": "__pi_eval__"}
loop = asyncio.new_event_loop()

def safe_repr(value):
    try:
        return repr(value)
    except Exception as error:
        return "<repr failed: %s>" % error

sys.__stdout__.write(PREFIX + json.dumps({"type": "ready"}) + "\n")
sys.__stdout__.flush()

for raw in sys.stdin:
    try:
        request = json.loads(raw)
        request_id = request.get("id")
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
protocol.write(PREFIX + JSON.stringify({ type: "ready" }) + "\n");

for await (const raw of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let request;
  try {
    request = JSON.parse(raw);
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
      if (!(error instanceof SyntaxError) || !String(error.message).toLowerCase().includes("await")) throw error;
      value = vm.runInContext("(async () => { " + request.code + "\n})()", context, { filename: "<pi-eval>" });
    }
    if (value && typeof value.then === "function") value = await value;
    protocol.write(PREFIX + JSON.stringify({ id: request.id, ok: true, stdout: stdout.join("\n"), stderr: stderr.join("\n"), value: util.inspect(value, { depth: 6, colors: false }) }) + "\n");
  } catch (error) {
    protocol.write(PREFIX + JSON.stringify({ id: request?.id, ok: false, stdout: "", stderr: "", error: error instanceof Error ? error.stack ?? error.message : String(error) }) + "\n");
  }
}
`;
