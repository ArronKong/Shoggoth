#!/usr/bin/env python3
"""Independent Ticketmaster Discovery v2 CLI, version 0.2.1.
Standard library, GET queries only. Commerce offers and ticket purchases are disabled.
TICKETMASTER_API_KEY (or TICKETMASTER_CONSUMER_KEY) supplies credentials.
API rate limits are account-specific; consult Rate-Limit response headers."""

import argparse
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.2.1"
DISCOVERY = "https://app.ticketmaster.com/discovery/v2"
COMMERCE = "https://app.ticketmaster.com/commerce/v1"


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


def key_candidate(args):
    return (getattr(args, "api_key", None) or os.environ.get("TICKETMASTER_API_KEY") or os.environ.get("TICKETMASTER_CONSUMER_KEY") or "").strip()


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


def get_key(args):
    key = key_candidate(args)
    if not key:
        raise CliError(
            "没有找到 Ticketmaster API key：设置环境变量 TICKETMASTER_API_KEY，"
            "或传 --api-key。去 developer.ticketmaster.com → My Apps → "
            "Add New App，生成的 Consumer Key 就是 apikey（免费额度 5000 次/天）。"
        , code="missing_key")
    if any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise CliError("API key 包含无效空白或控制字符", code="invalid_key")
    return key


def api_call(args, base, path, params):
    """key 只放进真实请求的 URL；dry-run 打印的 URL 里 key 打码。"""
    if base != DISCOVERY:
        raise CliError("当前免费范围仅启用 Discovery API；Commerce/Top Picks 等接口未启用", code="not_in_free_profile")
    if getattr(args, "dry_run", False):
        shown = dict(params)
        shown["apikey"] = "<set>"
        print(json.dumps({"dry_run": True, "method": "GET", "url": "%s%s?%s" % (base, path, urllib.parse.urlencode(shown)), "network_calls": 0}, indent=2, ensure_ascii=False))
        return None
    key = get_key(args)
    full = dict(params)
    full["apikey"] = key
    url = "%s%s?%s" % (base, path, urllib.parse.urlencode(full))
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as resp:
            body = resp.read(4 * 1024 * 1024 + 1)
            if len(body) > 4 * 1024 * 1024:
                raise CliError("API 返回内容过大，请缩小每页条数", code="invalid_response")
            result = json.loads(body.decode("utf-8"))
            if not isinstance(result, (dict, list)):
                raise CliError("API 返回了不支持的数据结构", code="invalid_response")
            return scrub(result, key)
    except urllib.error.HTTPError as e:
        hint = ""
        if e.code == 401:
            hint = "（key 无效：检查 TICKETMASTER_API_KEY 是否复制完整）"
        elif e.code == 403:
            hint = "（你的 key 没有这个端点的权限：Commerce offers 尤其常见）"
        elif e.code == 429:
            hint = "（达到调用限额；以账户的 Rate-Limit-* 响应头为准，不自动重试）"
        reset = e.headers.get("Rate-Limit-Reset") if e.headers else None
        e.close()
        raise CliError("HTTP %d%s" % (e.code, hint), code="api_error", status=e.code, rate_limit_reset=reset)
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

def check_size(value):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise CliError("--size 必须是整数（收到 %r）" % (value,))
    if n < 1 or n > 200:
        raise CliError("--size 只能在 1～200 之间（收到 %d）" % n)
    return n


def check_page(value, size):
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise CliError("--page 必须是整数（收到 %r）" % (value,))
    if n < 0:
        raise CliError("--page 从 0 开始，不能为负")
    if n * size >= 1000:
        raise CliError("Discovery 深分页要求 page*size < 1000")
    return n


def norm_datetime(s, is_end=False):
    """日期边界按 UTC；完整时间必须带时区并归一化为 UTC。"""
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s or ""):
            datetime.date.fromisoformat(s)
            return s + ("T23:59:59Z" if is_end else "T00:00:00Z")
        result = datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    except (ValueError, TypeError, AttributeError):
        raise CliError("日期必须是 YYYY-MM-DD 或带时区的完整 ISO 8601")


# ---------- 格式化 ----------

def price_range_str(pr):
    if not pr:
        return "-"
    parts = []
    for r in pr:
        lo = r.get("min")
        hi = r.get("max")
        cur = r.get("currency") or ""
        if lo is not None and hi is not None and lo != hi:
            parts.append("%s-%s %s" % (lo, hi, cur))
        elif lo is not None:
            parts.append("%s %s" % (lo, cur))
    return " / ".join(parts) if parts else "-"


def venue_str(ev):
    venues = (ev.get("_embedded") or {}).get("venues") or []
    if not venues:
        return "-"
    v = venues[0]
    city = (v.get("city") or {}).get("name") or ""
    return "%s, %s" % (v.get("name") or "-", city) if city else (v.get("name") or "-")


def fmt_events(data):
    events = (data.get("_embedded") or {}).get("events") or []
    page = data.get("page") or {}
    if not events:
        print("(没有结果)")
        return
    for ev in events:
        d = ev.get("dates") or {}
        start = d.get("start") or {}
        when = "%s %s" % (start.get("localDate") or "-",
                          start.get("localTime") or "")
        status = (d.get("status") or {}).get("code") or "-"
        print("%s" % ev.get("name"))
        print("  %s (%s)  %s  status=%s" % (
            when.strip(), start.get("timezone") or d.get("timezone") or "-",
            venue_str(ev), status))
        print("  price: %s  id: %s" % (
            price_range_str(ev.get("priceRanges")), ev.get("id")))
        print("  url: %s" % ev.get("url"))
    print("page %s / %s, total %s" % (
        page.get("number"), page.get("totalPages"), page.get("totalElements")))


def fmt_event_details(data):
    print("name: %s" % data.get("name"))
    print("id: %s" % data.get("id"))
    print("url: %s" % data.get("url"))
    d = data.get("dates") or {}
    start = d.get("start") or {}
    print("when: %s %s (%s)" % (
        start.get("localDate"), start.get("localTime"),
        start.get("timezone") or d.get("timezone")))
    print("status: %s" % (d.get("status") or {}).get("code"))
    for v in (data.get("_embedded") or {}).get("venues") or []:
        addr = v.get("address") or {}
        print("venue: %s, %s %s, %s %s" % (
            v.get("name"), addr.get("line1") or "",
            (v.get("city") or {}).get("name") or "",
            (v.get("state") or {}).get("name") or "",
            (v.get("country") or {}).get("name") or ""))
    for c in data.get("classifications") or []:
        print("classification: %s / %s / %s" % (
            (c.get("segment") or {}).get("name"),
            (c.get("genre") or {}).get("name"),
            (c.get("subGenre") or {}).get("name")))
    print("priceRanges: %s" % price_range_str(data.get("priceRanges")))
    seatmap = data.get("seatmap") or {}
    if seatmap.get("staticUrl"):
        print("seatmap: %s" % seatmap["staticUrl"])
    if data.get("ticketLimit"):
        print("ticketLimit: %s" % json.dumps(data["ticketLimit"], ensure_ascii=False))
    if data.get("pleaseNote"):
        print("pleaseNote: %s" % data["pleaseNote"])


def fmt_venues(data):
    venues = (data.get("_embedded") or {}).get("venues") or []
    if not venues:
        print("(没有结果)")
        return
    for v in venues:
        print("%s — %s, %s — id: %s — %s" % (
            v.get("name"),
            (v.get("city") or {}).get("name") or "",
            (v.get("country") or {}).get("name") or "",
            v.get("id"), v.get("url") or "-"))


def fmt_attractions(data):
    atts = (data.get("_embedded") or {}).get("attractions") or []
    if not atts:
        print("(没有结果)")
        return
    for a in atts:
        print("%s — id: %s — %s" % (a.get("name"), a.get("id"), a.get("url") or "-"))


def fmt_offers(data):
    offers = None
    if isinstance(data, dict):
        offers = data.get("offers") or data.get("_embedded", {}).get("offers")
    if isinstance(data, list):
        offers = data
    if not offers:
        print("Commerce API 没有返回 offers（可能是该活动无公开报价，或你的 key 没有 Commerce 权限）。")
        print("改用 event-details 里的 url 去 ticketmaster.com 官网看座位和价格。")
        return
    print("offers: %d（字段按实际返回打印，缺失的留空；原始 JSON 见 --json）" % len(offers))
    for o in offers:
        if not isinstance(o, dict):
            print("  %s" % o)
            continue
        bits = []
        for k in ("id", "name", "price", "currency", "url", "description"):
            if o.get(k) is not None:
                bits.append("%s=%s" % (k, o[k]))
        prices = o.get("prices") or o.get("priceRanges")
        if prices:
            bits.append("prices=%s" % json.dumps(prices, ensure_ascii=False))
        print("  " + (" | ".join(bits) if bits else json.dumps(o, ensure_ascii=False)))


# ---------- 子命令 ----------

def add_common(p, suppress=True):
    default = lambda value: argparse.SUPPRESS if suppress else value
    p.add_argument("--api-key", default=default(None), help="优先使用 TICKETMASTER_API_KEY 环境变量")
    p.add_argument("--json", action="store_true", default=default(False), help="JSON 输出，包括错误；响应中的 key 会打码")
    p.add_argument("--dry-run", action="store_true", default=default(False), help="只打印请求（key 打码），不发送")


def add_paging_args(p):
    p.add_argument("--size", type=int, default=10, help="每页条数（默认 10，最大 200）")
    p.add_argument("--page", type=int, default=0, help="页码，从 0 开始")


def paging(params, args):
    size = check_size(args.size)
    page = check_page(args.page, size)
    params["size"] = size
    params["page"] = page


def cmd_search_events(args):
    if args.keyword is not None and not args.keyword.strip():
        raise CliError("关键词不能为空")
    if not re.fullmatch(r"[A-Za-z]{2}", args.country_code or ""):
        raise CliError("country-code 必须是两字母国家代码")
    params = {"keyword": args.keyword} if args.keyword is not None else {}
    if args.city:
        params["city"] = args.city
    if args.state_code:
        params["stateCode"] = args.state_code
    params["countryCode"] = args.country_code.upper()
    if args.classification_name:
        params["classificationName"] = args.classification_name
    if args.start_date:
        params["startDateTime"] = norm_datetime(args.start_date, is_end=False)
    if args.end_date:
        params["endDateTime"] = norm_datetime(args.end_date, is_end=True)
    if args.start_date and args.end_date and params["startDateTime"] > params["endDateTime"]:
        raise CliError("开始时间不能晚于结束时间")
    if args.sort:
        params["sort"] = args.sort
    paging(params, args)
    data = api_call(args, DISCOVERY, "/events.json", params)
    emit(args, data, fmt_events)


def cmd_event_details(args):
    if not args.event_id.strip():
        raise CliError("event-id 不能为空")
    data = api_call(args, DISCOVERY, "/events/%s.json" % urllib.parse.quote(args.event_id, safe=""), {})
    emit(args, data, fmt_event_details)


def cmd_venues(args):
    if not re.fullmatch(r"[A-Za-z]{2}", args.country_code or ""):
        raise CliError("country-code 必须是两字母国家代码")
    params = {"countryCode": args.country_code.upper()}
    if args.keyword:
        params["keyword"] = args.keyword
    if args.city:
        params["city"] = args.city
    paging(params, args)
    data = api_call(args, DISCOVERY, "/venues.json", params)
    emit(args, data, fmt_venues)


def cmd_attractions(args):
    params = {}
    if args.keyword:
        params["keyword"] = args.keyword
    if args.classification_name:
        params["classificationName"] = args.classification_name
    paging(params, args)
    data = api_call(args, DISCOVERY, "/attractions.json", params)
    emit(args, data, fmt_attractions)


def cmd_offers(args):
    raise CliError("免费版未启用 Commerce offers；请用 event-details 返回的公开活动链接查看座位和实际价格", code="not_in_free_profile")


def build_parser():
    p = SafeParser(prog="ticketmaster", description="Ticketmaster CLI（仅公开 Discovery API，不购买门票）")
    add_common(p, suppress=False)
    p.add_argument("--version", action="version", version="ticketmaster " + VERSION)
    sub = p.add_subparsers(dest="cmd", metavar="COMMAND", parser_class=SafeParser)

    s = sub.add_parser("search-events", help="搜活动（关键词/城市/国家/分类/日期）")
    s.add_argument("--keyword", default=None, help="关键词：活动名、艺人、球队等；可省略以按日期、城市或分类浏览")
    s.add_argument("--city", default=None)
    s.add_argument("--state-code", default=None, help="美国州代码，如 CA、NY")
    s.add_argument("--country-code", default="US", help="国家代码，默认 US（Muse 版同款默认值）")
    s.add_argument("--classification-name", default=None, help="如 music、sports、arts & theatre")
    s.add_argument("--start-date", default=None, help="YYYY-MM-DD 或完整 ISO 8601")
    s.add_argument("--end-date", default=None, help="YYYY-MM-DD 或完整 ISO 8601")
    s.add_argument("--sort", default=None, help='如 date,asc、relevance,desc、name,asc')
    add_paging_args(s); add_common(s); s.set_defaults(fn=cmd_search_events)

    s = sub.add_parser("event-details", help="单个活动的详情（含场馆、票价区间、座位图链接）")
    s.add_argument("--event-id", required=True, help="Ticketmaster 活动 ID")
    add_common(s); s.set_defaults(fn=cmd_event_details)

    s = sub.add_parser("venues", help="搜场馆")
    s.add_argument("--keyword", default=None)
    s.add_argument("--city", default=None)
    s.add_argument("--country-code", default="US")
    add_paging_args(s); add_common(s); s.set_defaults(fn=cmd_venues)

    s = sub.add_parser("attractions", help="搜艺人/球队/演出方")
    s.add_argument("--keyword", default=None)
    s.add_argument("--classification-name", default=None)
    add_paging_args(s); add_common(s); s.set_defaults(fn=cmd_attractions)

    s = sub.add_parser("offers", help="兼容占位：免费版未启用 Commerce 接口")
    s.add_argument("--event-id", required=True)
    add_common(s); s.set_defaults(fn=cmd_offers)

    return p


def main(argv=None):
    raw = list(argv) if argv is not None else sys.argv[1:]
    args = None
    try:
        args = build_parser().parse_args(raw)
        if not getattr(args, "fn", None):
            raise CliError("请选择子命令；用 --help 查看")
        args.fn(args)
    except CliError as e:
        error = {"ok": False, "error": {"code": e.code, "message": str(e), **e.details}}
        error = scrub(error, key_candidate(args) if args else (os.environ.get("TICKETMASTER_API_KEY") or os.environ.get("TICKETMASTER_CONSUMER_KEY") or ""))
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
