#!/usr/bin/env python3
"""Independent FlightAware AeroAPI v4 CLI, version 0.2.1.
Standard library, read-only. Metered queries require --allow-metered; this is not a free-usage cap.
FLIGHTAWARE_API_KEY (or AEROAPI_KEY) supplies credentials. No remote writes are enabled."""

import argparse
import base64
import binascii
import datetime
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.2.1"
BASE = "https://aeroapi.flightaware.com/aeroapi"


class CliError(Exception):
    def __init__(self, message, code="invalid_arguments", **details):
        super().__init__(message)
        self.code, self.details = code, details


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise CliError(message)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def scrub(value, key):
    if isinstance(value, str):
        for secret in (key, urllib.parse.quote(key, safe=""), urllib.parse.quote_plus(key)) if key else ():
            value = value.replace(secret, "[REDACTED]")
        return value
    if isinstance(value, dict):
        return {scrub(k, key): scrub(v, key) for k, v in value.items()}
    if isinstance(value, list):
        return [scrub(v, key) for v in value]
    return value


def key_candidate(args):
    return (getattr(args, "api_key", None) or os.environ.get("FLIGHTAWARE_API_KEY") or os.environ.get("AEROAPI_KEY") or "").strip()


def get_key(args):
    key = key_candidate(args)
    if not key:
        raise CliError(
            "没有找到 FlightAware API key：设置环境变量 FLIGHTAWARE_API_KEY，"
            "或传 --api-key。去 flightaware.com/aeroapi 注册 Personal 套餐"
            "（每月 $5 免费额度，个人/学术用途）后，在 AeroAPI portal 里找 key。"
        , code="missing_key")
    if any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise CliError("API key 包含无效空白或控制字符", code="invalid_key")
    return key


def build_url(path, params):
    qs = urllib.parse.urlencode([(k, v) for k, v in params.items() if v is not None])
    return BASE + path + ("?" + qs if qs else "")


def api_call(args, method, path, params=None, body=None):
    if method != "GET" or body is not None:
        raise CliError("此版本只允许查询；flight-intent 等远程写入已禁用", code="read_only_profile")
    url = build_url(path, params or {})
    if getattr(args, "dry_run", False):
        print(json.dumps({"dry_run": True, "method": method, "url": url,
                          "headers": {"x-apikey": "[REDACTED]", "Accept": "application/json"},
                          "network_calls": 0}, ensure_ascii=False, indent=2))
        return None
    # The provider bills reads too. Only its documented $0 account-usage endpoint
    # bypasses the explicit metered-network switch. No local estimate is a free cap.
    if path != "/account/usage" and not getattr(args, "allow_metered", False):
        raise CliError("FlightAware 查询可能产生费用；免费用量不是硬上限。确认账户用量后显式加 --allow-metered 才联网", code="metered_api_disabled")
    key = get_key(args)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("x-apikey", key)
    req.add_header("Accept", "application/json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as resp:
            raw = resp.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise CliError("API response exceeds the size limit", code="response_too_large")
            result = json.loads(raw.decode("utf-8")) if raw else {}
            if not isinstance(result, (dict, list)):
                raise CliError("API 返回了不支持的数据结构", code="invalid_response")
            return scrub(result, key)
    except urllib.error.HTTPError as e:
        hint = ""
        if e.code == 401:
            hint = "（key 无效或未开通：检查 FLIGHTAWARE_API_KEY 是否复制完整）"
        elif e.code == 403:
            hint = "（你的套餐不含这个端点：Personal 不含历史数据与 Foresight）"
        elif e.code == 429:
            hint = "（限速：Personal 是 10 个结果集/分钟，等一分钟再试）"
        elif e.code == 400:
            hint = "（参数不对：看上面 AeroAPI 返回的 reason/detail）"
        request_id = e.headers.get("x-request-id") if e.headers else None
        e.close()
        raise CliError("HTTP %d%s" % (e.code, hint), code="api_error", status=e.code, request_id=request_id)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise CliError("网络连接失败；未自动重试", code="network_error")
    except (ValueError, UnicodeError):
        raise CliError("API 未返回有效 JSON", code="invalid_response")


def emit(args, data, fmt=None):
    if data is None:  # dry-run
        return
    if getattr(args, "json", False) or fmt is None:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        fmt(data)


# ---------- 参数校验（先于 key 校验） ----------

def parse_date(s, flag="--date"):
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s or ""):
            raise ValueError()
        return datetime.datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        raise CliError("%s 必须是 YYYY-MM-DD，例如 2026-10-29（收到 %r）" % (flag, s))


def parse_timestamp(value):
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or ""):
            result = datetime.datetime.combine(parse_date(value), datetime.time(), datetime.timezone.utc)
        else:
            result = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if result.tzinfo is None:
                raise ValueError()
        return result.astimezone(datetime.timezone.utc)
    except (ValueError, TypeError, AttributeError):
        raise CliError("时间必须是 YYYY-MM-DD 或带时区的完整 ISO 8601")


def normalized_timestamp(value):
    return parse_timestamp(value).isoformat(timespec="seconds").replace("+00:00", "Z")


def validated_window(args):
    params = {}
    if getattr(args, "start", None):
        params["start"] = normalized_timestamp(args.start)
    if getattr(args, "end", None):
        params["end"] = normalized_timestamp(args.end)
    if len(params) == 2 and parse_timestamp(params["start"]) >= parse_timestamp(params["end"]):
        raise CliError("开始时间必须早于结束时间")
    return params


def day_window(date_str):
    """--date 当天（UTC）的 [start, end)，AeroAPI 日期默认 00:00:00Z。"""
    d = parse_date(date_str)
    start = d.strftime("%Y-%m-%dT00:00:00Z")
    end = (d + datetime.timedelta(days=1)).strftime("%Y-%m-%dT00:00:00Z")
    return start, end


def check_int(name, value, lo=None, hi=None):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise CliError("--%s 必须是整数（收到 %r）" % (name, value))
    if lo is not None and n < lo:
        raise CliError("--%s 不能小于 %d" % (name, lo))
    if hi is not None and n > hi:
        raise CliError("--%s 不能大于 %d" % (name, hi))
    return n


# ---------- 格式化 ----------

def ap(code):
    """机场 ref：优先 ICAO，否则 IATA，否则原样。"""
    if not isinstance(code, dict):
        return code or "-"
    return code.get("code_icao") or code.get("code_iata") or code.get("code") or "-"


def flight_row(f):
    ident = f.get("ident_icao") or f.get("ident") or "-"
    route = "%s->%s" % (ap(f.get("origin")), ap(f.get("destination")))
    status = f.get("status") or "-"
    sched = f.get("scheduled_out") or f.get("scheduled_off") or "-"
    fa = f.get("fa_flight_id") or "-"
    flags = "".join([
        " CANCELLED" if f.get("cancelled") else "",
        " DIVERTED" if f.get("diverted") else "",
        " BLOCKED" if f.get("blocked") else "",
    ])
    return "%-10s %-14s %-20s %-12s %s%s" % (ident, route, sched, status, fa, flags)


def fmt_flight_list(data, key):
    rows = data.get(key) or []
    if not rows:
        print("(没有结果)")
        return
    for f in rows:
        print(flight_row(f))
    links = (data.get("links") or {}).get("next")
    if links:
        print("(还有下一页，next 链接见 --json 输出)")


def fmt_flight_detail(data):
    flights = data.get("flights") or []
    if not flights:
        print("(没有结果)")
        return
    for f in flights:
        print("ident: %s (icao %s / iata %s)" % (
            f.get("ident"), f.get("ident_icao"), f.get("ident_iata")))
        print("fa_flight_id: %s" % f.get("fa_flight_id"))
        print("operator: %s  flight_number: %s  registration: %s  aircraft: %s" % (
            f.get("operator"), f.get("flight_number"),
            f.get("registration"), f.get("aircraft_type")))
        for side in ("origin", "destination"):
            a = f.get(side) or {}
            print("%s: %s %s %s  terminal=%s gate=%s" % (
                side, ap(a), a.get("city") or "", a.get("name") or "",
                a.get("terminal") or "-", a.get("gate") or "-"))
        for k in ("scheduled_out", "estimated_out", "actual_out",
                  "scheduled_off", "estimated_off", "actual_off",
                  "scheduled_on", "estimated_on", "actual_on",
                  "scheduled_in", "estimated_in", "actual_in"):
            if f.get(k):
                print("%s: %s" % (k, f[k]))
        print("status: %s  cancelled=%s diverted=%s blocked=%s" % (
            f.get("status"), f.get("cancelled"),
            f.get("diverted"), f.get("blocked")))
        print("-" * 60)


def fmt_position(data):
    p = data.get("last_position") if "last_position" in data else data
    if not isinstance(p, dict) or not p:
        print("(没有位置数据：航班可能还没起飞，或该机被屏蔽)")
        return
    for k in ("timestamp", "latitude", "longitude", "altitude",
              "groundspeed", "heading", "fa_flight_id"):
        if p.get(k) is not None:
            print("%s: %s" % (k, p[k]))


def fmt_track(data):
    pos = data.get("positions") or []
    print("positions: %d" % len(pos))
    if pos:
        print("first: %s" % json.dumps(pos[0], ensure_ascii=False))
        print("last:  %s" % json.dumps(pos[-1], ensure_ascii=False))


def fmt_route(data):
    print(json.dumps(data, indent=2, ensure_ascii=False))


def fmt_airport(data):
    print("name: %s" % data.get("name"))
    print("icao: %s  iata: %s  lid: %s" % (
        data.get("code_icao"), data.get("code_iata"), data.get("code_lid")))
    print("city: %s  state: %s  country: %s" % (
        data.get("city"), data.get("state"), data.get("country_code")))
    print("timezone: %s" % data.get("timezone"))
    print("latitude: %s  longitude: %s  elevation_ft: %s" % (
        data.get("latitude"), data.get("longitude"), data.get("elevation")))


def fmt_operator(data):
    print("name: %s" % data.get("name"))
    print("icao: %s  iata: %s  callsign: %s  country: %s" % (
        data.get("icao"), data.get("iata"),
        data.get("callsign"), data.get("country_code")))


def fmt_pretty(data):
    print(json.dumps(data, indent=2, ensure_ascii=False))


def fmt_schedules(data):
    rows = data.get("scheduled") or data.get("flights") or []
    if not rows:
        print("(没有结果)")
        return
    for s in rows:
        ident = s.get("ident_icao") or s.get("ident") or "-"
        route = "%s->%s" % (s.get("origin_icao") or ap(s.get("origin")),
                             s.get("destination_icao") or ap(s.get("destination")))
        print("%-10s %-14s out %s  in %s  %s  fa=%s" % (
            ident, route, s.get("scheduled_out") or s.get("departure_time"), s.get("scheduled_in") or s.get("arrival_time"),
            s.get("aircraft_type") or "-", s.get("fa_flight_id") or "-"))


# ---------- 子命令 ----------

def add_common(p, suppress=True):
    default = lambda value: argparse.SUPPRESS if suppress else value
    p.add_argument("--api-key", default=default(None), help="优先使用 FLIGHTAWARE_API_KEY 环境变量")
    p.add_argument("--json", action="store_true", default=default(False), help="JSON 输出，包括错误")
    p.add_argument("--dry-run", action="store_true", default=default(False), help="只打印请求，不发送或写文件")
    p.add_argument("--allow-metered", action="store_true", default=default(False), help="显式启用可能计费的查询；此开关不保证免费额度尚有剩余")


def add_paging(p):
    p.add_argument("--max-pages", type=int, default=1, help="最多取几页（默认 1）")
    p.add_argument("--cursor", default=None, help="上一页返回的游标")


def add_window(p):
    p.add_argument("--start", default=None, help="开始时间，ISO 8601 或 YYYY-MM-DD")
    p.add_argument("--end", default=None, help="结束时间，ISO 8601 或 YYYY-MM-DD")


def cmd_status(args):
    if not args.verify:
        print(json.dumps({"version": VERSION, "base": BASE, "key_configured": bool(key_candidate(args)),
                          "remote_verified": False, "metered_network_enabled": args.allow_metered,
                          "profile": "read_only", "network_calls": 0}, indent=2))
        return
    data = api_call(args, "GET", "/account/usage")
    emit(args, data, fmt_pretty)


def cmd_flight(args):
    params = validated_window(args)
    if args.date:
        if args.start or args.end:
            raise CliError("--date 不能和 --start/--end 同时使用")
        start, end = day_window(args.date)
        params["start"], params["end"] = start, end
    if args.ident_type:
        params["ident_type"] = args.ident_type
    params["max_pages"] = check_int("max-pages", args.max_pages, lo=1, hi=10)
    if args.cursor:
        params["cursor"] = args.cursor
    data = api_call(args, "GET", "/flights/%s" % urllib.parse.quote(args.ident, safe=""), params)
    emit(args, data, fmt_flight_detail)


def cmd_canonical_flight(args):
    data = api_call(args, "GET", "/flights/%s/canonical" % urllib.parse.quote(args.ident, safe=""))
    emit(args, data, fmt_pretty)


def cmd_position(args):
    data = api_call(args, "GET", "/flights/%s/position" % urllib.parse.quote(args.fa_id, safe=""))
    emit(args, data, fmt_position)


def cmd_track(args):
    params = {}
    if args.include_estimated_positions is not None:
        params["include_estimated_positions"] = args.include_estimated_positions
    data = api_call(args, "GET", "/flights/%s/track" % urllib.parse.quote(args.fa_id, safe=""), params)
    emit(args, data, fmt_track)


def cmd_route(args):
    data = api_call(args, "GET", "/flights/%s/route" % urllib.parse.quote(args.fa_id, safe=""))
    emit(args, data, fmt_route)


def cmd_map(args):
    if args.save:
        target = Path(args.save).expanduser()
        if target.is_symlink() or target.is_dir() or not target.parent.is_dir():
            raise CliError("地图输出路径不可用或是符号链接")
    params = {"width": check_int("width", args.width, lo=1, hi=1500),
              "height": check_int("height", args.height, lo=1, hi=1500)}
    data = api_call(args, "GET", "/flights/%s/map" % urllib.parse.quote(args.fa_id, safe=""), params)
    if data is None:
        return
    b64 = data.get("map") or ""
    if args.save:
        try:
            raw = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError, TypeError):
            raise CliError("地图不是有效 base64 图片", code="invalid_response")
        if not (raw.startswith(b"\x89PNG\r\n\x1a\n") or raw.startswith(b"\xff\xd8\xff") or raw.startswith((b"GIF87a", b"GIF89a"))):
            raise CliError("地图响应不是受支持的图片", code="invalid_response")
        target = Path(args.save).expanduser()
        if target.is_symlink() or not target.parent.is_dir():
            raise CliError("地图输出路径不可用或是符号链接")
        fd, temporary = tempfile.mkstemp(prefix=".flightaware-", dir=str(target.parent))
        try:
            with os.fdopen(fd, "wb") as stream:
                os.fchmod(stream.fileno(), 0o600)
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        if not args.json:
            print("已保存：%s（%d 字节）" % (args.save, len(raw)))
    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
    elif not args.save:
        print("地图图片 base64 共 %d 字符；加 --save PATH 写成图片文件。" % len(b64))


def cmd_search(args, advanced=False):
    if not args.query.strip():
        raise CliError("查询语句不能为空")
    params = {"query": args.query,
              "max_pages": check_int("max-pages", args.max_pages, lo=1, hi=10)}
    if args.cursor:
        params["cursor"] = args.cursor
    path = "/flights/search/advanced" if advanced else "/flights/search"
    data = api_call(args, "GET", path, params)
    emit(args, data, lambda d: fmt_flight_list(d, "flights"))


def cmd_schedules(args):
    if not args.date_start or not args.date_end:
        raise CliError("schedules 需要 DATE_START DATE_END，例如：schedules 2026-11-01 2026-11-02")
    start, end = parse_timestamp(args.date_start), parse_timestamp(args.date_end)
    if not start < end or end - start > datetime.timedelta(days=21):
        raise CliError("时刻表窗口必须大于 0 且不超过 21 天")
    start_path = args.date_start if len(args.date_start) == 10 else normalized_timestamp(args.date_start)
    end_path = args.date_end if len(args.date_end) == 10 else normalized_timestamp(args.date_end)
    params = {}
    if args.origin:
        params["origin"] = args.origin
    if args.destination:
        params["destination"] = args.destination
    if args.airline:
        params["airline"] = args.airline
    if args.flight_number:
        params["flight_number"] = check_int("flight-number", args.flight_number, lo=1)
    params["max_pages"] = check_int("max-pages", args.max_pages, lo=1, hi=10)
    if args.cursor:
        params["cursor"] = args.cursor
    data = api_call(args, "GET", "/schedules/%s/%s" % (urllib.parse.quote(start_path, safe=""), urllib.parse.quote(end_path, safe="")), params)
    emit(args, data, fmt_schedules)


def cmd_airport(args):
    data = api_call(args, "GET", "/airports/%s" % urllib.parse.quote(args.id, safe=""))
    emit(args, data, fmt_airport)


AIRPORT_FLIGHT_KINDS = {
    "all": "flights",
    "arrivals": "flights/arrivals",
    "departures": "flights/departures",
    "scheduled-departures": "flights/scheduled_departures",
    "scheduled-arrivals": "flights/scheduled_arrivals",
}


def cmd_airport_flights(args):
    sub = AIRPORT_FLIGHT_KINDS[args.kind]
    params = validated_window(args)
    if args.airline:
        params["airline"] = args.airline
    params["max_pages"] = check_int("max-pages", args.max_pages, lo=1, hi=10)
    if args.cursor:
        params["cursor"] = args.cursor
    data = api_call(args, "GET", "/airports/%s/%s" % (
        urllib.parse.quote(args.id, safe=""), sub), params)
    key = {"all": None, "arrivals": "arrivals", "departures": "departures",
           "scheduled-departures": "scheduled_departures",
           "scheduled-arrivals": "scheduled_arrivals"}[args.kind]
    if key is None:
        def fmt_all(d):
            for k in ("scheduled_departures", "scheduled_arrivals",
                      "departures", "arrivals"):
                rows = d.get(k) or []
                if rows:
                    print("== %s (%d) ==" % (k, len(rows)))
                    for f in rows:
                        print(flight_row(f))
        emit(args, data, fmt_all)
    else:
        emit(args, data, lambda d: fmt_flight_list(d, key))


def cmd_airport_to(args):
    if not args.date:
        args.date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    start, end = day_window(args.date)
    params = {"origin": args.origin, "destination": args.destination}
    data = api_call(args, "GET", "/schedules/%s/%s" % (start[:10], end[:10]), params)
    emit(args, data, fmt_schedules)


def cmd_airport_delays(args):
    data = api_call(args, "GET", "/airports/%s/delays" % urllib.parse.quote(args.id, safe=""))
    emit(args, data, fmt_pretty)


def cmd_airport_weather(args):
    data = api_call(args, "GET", "/airports/%s/weather/%s" % (
        urllib.parse.quote(args.id, safe=""), args.kind))
    emit(args, data, fmt_pretty)


def cmd_airport_counts(args):
    data = api_call(args, "GET", "/airports/%s/flights/counts" % urllib.parse.quote(args.id, safe=""))
    emit(args, data, fmt_pretty)


def cmd_operator(args):
    data = api_call(args, "GET", "/operators/%s" % urllib.parse.quote(args.id, safe=""))
    emit(args, data, fmt_operator)


OPERATOR_FLIGHT_KINDS = {
    "all": "flights",
    "scheduled": "flights/scheduled",
    "arrivals": "flights/arrivals",
    "enroute": "flights/enroute",
}


def cmd_operator_flights(args):
    sub = OPERATOR_FLIGHT_KINDS[args.kind]
    params = validated_window(args)
    params["max_pages"] = check_int("max-pages", args.max_pages, lo=1, hi=10)
    if args.cursor:
        params["cursor"] = args.cursor
    data = api_call(args, "GET", "/operators/%s/%s" % (
        urllib.parse.quote(args.id, safe=""), sub), params)
    key = {"all": "flights", "scheduled": "scheduled",
           "arrivals": "arrivals", "enroute": "enroute"}[args.kind]
    def formatted(d):
        if args.kind == "all" and not d.get("flights"):
            for group in ("scheduled", "arrivals", "enroute"):
                if d.get(group):
                    print(group + ":")
                    fmt_flight_list(d, group)
        else:
            fmt_flight_list(d, key)
    emit(args, data, formatted)


def cmd_operator_counts(args):
    data = api_call(args, "GET", "/operators/%s/flights/counts" % urllib.parse.quote(args.id, safe=""))
    emit(args, data, fmt_pretty)


def cmd_disruptions(args):
    if args.entity_type not in ("airline", "origin", "destination"):
        raise CliError("--entity-type 只能是 airline / origin / destination")
    if args.time_period not in ("yesterday", "today", "tomorrow", "plus2days",
                                "twoDaysAgo", "minus2plus12hrs", "next36hrs", "week"):
        raise CliError("--time-period 不在 AeroAPI 枚举里")
    path = "/disruption_counts/%s" % args.entity_type
    if args.id:
        path += "/%s" % urllib.parse.quote(args.id, safe="")
    data = api_call(args, "GET", path, {"time_period": args.time_period})
    emit(args, data, fmt_pretty)


def cmd_aircraft_blocked(args):
    data = api_call(args, "GET", "/aircraft/%s/blocked" % urllib.parse.quote(args.ident, safe=""))
    emit(args, data, fmt_pretty)


def cmd_aircraft_owner(args):
    data = api_call(args, "GET", "/aircraft/%s/owner" % urllib.parse.quote(args.ident, safe=""))
    emit(args, data, fmt_pretty)


def cmd_flight_intent(args):
    raise CliError("当前安装版仅做查询；flight-intent 远程写入已禁用", code="read_only_profile")


def build_parser():
    p = SafeParser(prog="flightaware", description="FlightAware 只读 CLI；计费查询默认关闭")
    add_common(p, suppress=False)
    p.add_argument("--version", action="version", version="flightaware " + VERSION)
    sub = p.add_subparsers(dest="cmd", metavar="COMMAND", parser_class=SafeParser)

    s = sub.add_parser("status", help="检查 key 与服务可达性")
    s.add_argument("--verify", action="store_true", help="读取官方标价为 $0 的 /account/usage 检查 key")
    add_common(s); s.set_defaults(fn=cmd_status)

    s = sub.add_parser("flight", help="按航班号/注册号/fa_flight_id 查状态")
    s.add_argument("ident", help="例如 UAL123（建议用 ICAO 航班号）、N123HQ、fa_flight_id")
    s.add_argument("--date", default=None, help="起飞日期 YYYY-MM-DD（UTC 当天窗口）")
    s.add_argument("--ident-type", choices=["designator", "registration", "fa_flight_id"], default=None)
    add_window(s); add_paging(s); add_common(s); s.set_defaults(fn=cmd_flight)

    s = sub.add_parser("canonical-flight", help="解析规范航班标识")
    s.add_argument("ident"); add_common(s); s.set_defaults(fn=cmd_canonical_flight)

    s = sub.add_parser("position", help="fa_flight_id 的当前位置")
    s.add_argument("fa_id"); add_common(s); s.set_defaults(fn=cmd_position)

    s = sub.add_parser("track", help="fa_flight_id 的轨迹")
    s.add_argument("fa_id")
    s.add_argument("--include-estimated-positions", choices=["true", "false"], default=None)
    add_common(s); s.set_defaults(fn=cmd_track)

    s = sub.add_parser("route", help="fa_flight_id 的申报航路")
    s.add_argument("fa_id"); add_common(s); s.set_defaults(fn=cmd_route)

    s = sub.add_parser("map", help="fa_flight_id 的航迹地图（base64 图片）")
    s.add_argument("fa_id")
    s.add_argument("--save", default=None, help="保存成图片文件，例如 map.png")
    s.add_argument("--width", type=int, default=640)
    s.add_argument("--height", type=int, default=480)
    add_common(s); s.set_defaults(fn=cmd_map)

    s = sub.add_parser("search", help="搜空中航班（简化查询语法，例：-origin KJFK -destination KLAX）")
    s.add_argument("query", help='例如 "-origin KJFK -destination KLAX"、"-idents UAL123"')
    add_paging(s); add_common(s); s.set_defaults(fn=lambda a: cmd_search(a, False))

    s = sub.add_parser("search-advanced", help="搜空中航班（高级查询语法）")
    s.add_argument("query")
    add_paging(s); add_common(s); s.set_defaults(fn=lambda a: cmd_search(a, True))

    s = sub.add_parser("schedules", help="查公布的时刻表（3 个月前～1 年后，窗口 ≤3 周）")
    s.add_argument("date_start", nargs="?", help="YYYY-MM-DD 或 ISO 时间")
    s.add_argument("date_end", nargs="?", help="YYYY-MM-DD 或 ISO 时间")
    s.add_argument("--origin", default=None, help="起飞机场 ICAO/IATA")
    s.add_argument("--destination", default=None, help="到达机场 ICAO/IATA")
    s.add_argument("--airline", default=None, help="航司 ICAO/IATA，如 UAL")
    s.add_argument("--flight-number", default=None, help="纯数字航班号")
    add_paging(s); s.set_defaults(fn=cmd_schedules)
    add_common(s)

    s = sub.add_parser("airport", help="机场元数据")
    s.add_argument("id", help="ICAO 优先，如 KJFK"); add_common(s); s.set_defaults(fn=cmd_airport)

    s = sub.add_parser("airport-flights", help="机场 FIDS 航班")
    s.add_argument("id", help="机场 ICAO/IATA")
    s.add_argument("kind", choices=list(AIRPORT_FLIGHT_KINDS))
    s.add_argument("--airline", default=None, help="航司 ICAO，如 UAL")
    add_window(s); add_paging(s); add_common(s); s.set_defaults(fn=cmd_airport_flights)

    s = sub.add_parser("airport-to", help="两机场之间的时刻表航班（走 schedules 接口）")
    s.add_argument("origin"); s.add_argument("destination")
    s.add_argument("--date", default=None, help="日期 YYYY-MM-DD，默认今天（UTC）")
    add_common(s); s.set_defaults(fn=cmd_airport_to)

    s = sub.add_parser("airport-delays", help="单个机场的延误情况")
    s.add_argument("id", help="机场 ICAO/IATA"); add_common(s); s.set_defaults(fn=cmd_airport_delays)

    s = sub.add_parser("airport-weather", help="机场天气实况或预报")
    s.add_argument("id")
    s.add_argument("kind", nargs="?", default="observations", choices=["observations", "forecast"])
    add_common(s); s.set_defaults(fn=cmd_airport_weather)

    s = sub.add_parser("airport-counts", help="机场各类别航班计数")
    s.add_argument("id"); add_common(s); s.set_defaults(fn=cmd_airport_counts)

    s = sub.add_parser("operator", help="航司元数据")
    s.add_argument("id", help="航司 ICAO，如 UAL"); add_common(s); s.set_defaults(fn=cmd_operator)

    s = sub.add_parser("operator-flights", help="航司航班")
    s.add_argument("id")
    s.add_argument("kind", choices=list(OPERATOR_FLIGHT_KINDS))
    add_window(s); add_paging(s); add_common(s); s.set_defaults(fn=cmd_operator_flights)

    s = sub.add_parser("operator-counts", help="航司航班计数")
    s.add_argument("id"); add_common(s); s.set_defaults(fn=cmd_operator_counts)

    s = sub.add_parser("disruptions", help="延误/取消统计（全局或单个实体）")
    s.add_argument("entity_type", choices=["airline", "origin", "destination"])
    s.add_argument("id", nargs="?", default=None, help="航司 ICAO 或机场代码（不填 = 全局）")
    s.add_argument("--time-period", default="today",
                   choices=["yesterday", "today", "tomorrow", "plus2days",
                            "twoDaysAgo", "minus2plus12hrs", "next36hrs", "week"])
    add_common(s); s.set_defaults(fn=cmd_disruptions)

    s = sub.add_parser("aircraft-blocked", help="查飞机是否被屏蔽公开追踪")
    s.add_argument("ident"); add_common(s); s.set_defaults(fn=cmd_aircraft_blocked)

    s = sub.add_parser("aircraft-owner", help="查飞机机主信息")
    s.add_argument("ident"); add_common(s); s.set_defaults(fn=cmd_aircraft_owner)

    s = sub.add_parser("flight-intent", help="兼容占位：当前只读版禁用此远程写入")
    s.add_argument("ident")
    s.add_argument("--body-json", required=True, help="JSON 请求体")
    s.add_argument("--confirm", action="store_true", help="确认执行")
    add_common(s); s.set_defaults(fn=cmd_flight_intent)

    return p


def main(argv=None):
    raw = list(argv) if argv is not None else sys.argv[1:]
    args = None
    try:
        args = build_parser().parse_args(raw)
        if not getattr(args, "fn", None):
            raise CliError("请选择子命令；用 --help 查看")
        for field in ("ident", "fa_id", "id", "origin", "destination"):
            value = getattr(args, field, None)
            if value is not None and (not value.strip() or any(c.isspace() or ord(c) < 32 for c in value)):
                raise CliError("标识符不能为空或包含空白/控制字符")
        args.fn(args)
    except CliError as e:
        error = {"ok": False, "error": {"code": e.code, "message": str(e), **e.details}}
        error = scrub(error, key_candidate(args) if args else (os.environ.get("FLIGHTAWARE_API_KEY") or os.environ.get("AEROAPI_KEY") or ""))
        if (args and args.json) or "--json" in raw:
            print(json.dumps(error, indent=2, ensure_ascii=False))
        else:
            print("错误：%s" % error["error"]["message"], file=sys.stderr)
        return 1
    except (ValueError, TypeError, OSError, KeyError):
        error = {"ok": False, "error": {"code": "local_error", "message": "本地文件或 API 数据格式错误"}}
        print(json.dumps(error, ensure_ascii=False), file=sys.stdout if "--json" in raw else sys.stderr)
        return 1
    except KeyboardInterrupt:
        print(json.dumps({"ok": False, "error": {"code": "interrupted", "message": "操作已中断，未自动重试"}}, ensure_ascii=False), file=sys.stdout if "--json" in raw else sys.stderr)
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
