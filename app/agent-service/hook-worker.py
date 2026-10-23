import asyncio
import inspect
import hashlib
import json
import sys
import io
import contextlib

def normalize_guard(fmt, value, exit_code, stderr):
    if exit_code == 2:
        return {"decision": "block", "reason": stderr.strip() or "Compatible guard exited with code 2"}
    if exit_code != 0 or value is not None and not isinstance(value, dict):
        raise ValueError("decision")
    if value is None:
        return {"decision": "allow"}
    def exact(obj, allowed):
        if not isinstance(obj, dict) or any(key not in allowed for key in obj):
            raise ValueError("unsupported output")
    if fmt == "claude-code-pretooluse-v1":
        exact(value, ["decision", "reason", "hookSpecificOutput"])
        if "hookSpecificOutput" in value:
            if "decision" in value or "reason" in value:
                raise ValueError("conflicting output")
            specific = value["hookSpecificOutput"]
            exact(specific, ["hookEventName", "permissionDecision", "permissionDecisionReason"])
            if specific.get("hookEventName") != "PreToolUse":
                raise ValueError("event")
            decision = {"allow": "allow", "deny": "block", "ask": "require_approval"}.get(specific.get("permissionDecision"))
            reason = specific.get("permissionDecisionReason")
        else:
            if not value:
                return {"decision": "allow"}
            decision = {"approve": "allow", "block": "block"}.get(value.get("decision"))
            reason = value.get("reason")
    elif fmt == "cursor-tool-permission-v1":
        exact(value, ["permission", "user_message", "agent_message"])
        decision = {"allow": "allow", "deny": "block", "ask": "require_approval"}.get(value.get("permission"))
        if any(key in value and not isinstance(value[key], str) for key in ["user_message", "agent_message"]):
            raise ValueError("message")
        reason = value.get("agent_message") or value.get("user_message")
    else:
        raise ValueError("format")
    if not decision or reason is not None and (not isinstance(reason, str) or not reason or len(reason.encode("utf-8")) > 1024 or "\0" in reason):
        raise ValueError("decision")
    return {"decision": decision, **({"reason": reason} if reason else {})}

class BoundedOutput(io.StringIO):
    def __init__(self, limit):
        super().__init__()
        self.limit = limit
    def write(self, value):
        if len((self.getvalue() + value).encode("utf-8")) > self.limit:
            raise ValueError("output")
        return super().write(value)

def compatible_guard(request, code):
    event = request["event"]
    native_input = {"hook_event_name": "PreToolUse", "tool_name": event["tool"]["name"], "tool_input": event["payload"]["arguments"],
                    "tool_use_id": event.get("toolCallId", event["eventId"]), "cwd": event["workspace"]}
    if isinstance(native_input["tool_input"].get("command"), str):
        native_input["command"] = native_input["tool_input"]["command"]
    scope = {"__name__": "__main__", "__file__": request["sourceFile"]}
    stdout, stderr = BoundedOutput(8192), BoundedOutput(1024)
    previous = sys.stdin
    exit_code, value = 0, None
    try:
        sys.stdin = io.StringIO(json.dumps(native_input, ensure_ascii=False, allow_nan=False))
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                exec(compile(code, "hook-handler.py", "exec"), scope)
                if callable(scope.get("handle")):
                    value = scope["handle"](native_input)
                    if inspect.isawaitable(value):
                        value = asyncio.run(value)
            except SystemExit as error:
                exit_code = error.code if error.code is not None else 0
                if not isinstance(exit_code, int):
                    raise ValueError("exit")
    finally:
        sys.stdin = previous
    if exit_code == 2:
        return normalize_guard(request["compatibility"], None, exit_code, stderr.getvalue())
    if stdout.getvalue().strip():
        if value is not None:
            raise ValueError("mixed output")
        value = json.loads(stdout.getvalue())
    return normalize_guard(request["compatibility"], value, exit_code, stderr.getvalue())

try:
    raw = sys.stdin.buffer.read(32769)
    if len(raw) > 32768:
        raise ValueError("input")
    request = json.loads(raw.decode("utf-8"))
    scope = {"__name__": "__hook__", "__file__": request["sourceFile"]}
    with open(request["sourceFile"], encoding="utf-8") as source:
        code = source.read()
    if hashlib.sha256(code.encode("utf-8")).hexdigest() != request["sourceDigest"]:
        raise ValueError("changed")
    if request.get("compatibility"):
        result = compatible_guard(request, code)
    else:
        exec(compile(code, "hook-handler.py", "exec"), scope)
        result = scope["handle"](request["event"])
        if inspect.isawaitable(result):
            result = asyncio.run(result)
    encoded = json.dumps(result, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode("utf-8")) > 8192:
        raise ValueError("output")
    sys.stdout.write(encoded + "\n")
except BaseException:
    sys.stderr.write("HOOK_WORKER_FAILED\n")
    sys.exit(2)
