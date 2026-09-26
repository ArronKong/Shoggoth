"use strict";

// 零依赖 mDNS 浏览端:发现局域网里广播 `_openclaw-gw._tcp` 的 OpenClaw 网关
// (官方 bonjour 扩展的服务类型)。首启向导远程面板的数据源。
// 只做浏览不做广播;IPv4 only(v1——官方扩展双栈广播,A 记录必在)。

const dgram = require("node:dgram");

const SERVICE = "_openclaw-gw._tcp.local";
const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const CACHE_MS = 5000;

let cache = null; // { at, value }

function encodeName(name) {
  const parts = name.split(".").filter(Boolean).map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, "utf8")]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function buildQuery() {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // QDCOUNT=1(offset 4;offset 6 是 ANCOUNT——写错会被 responder 静默丢弃)
  return Buffer.concat([header, encodeName(SERVICE), Buffer.from([0, 12, 0, 1])]); // PTR IN
}

// DNS 名字解码,支持 0xC0 压缩指针;跳数上限防循环包。
function decodeName(buf, offset) {
  const labels = [];
  let off = offset;
  let jumped = false;
  let next = -1;
  for (let hops = 0; hops < 32; hops++) {
    if (off >= buf.length) break;
    const len = buf[off];
    if (len === 0) { if (!jumped) next = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (off + 1 >= buf.length) break;
      if (!jumped) next = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumped = true;
      continue;
    }
    if (off + 1 + len > buf.length) break;
    labels.push(buf.subarray(off + 1, off + 1 + len).toString("utf8"));
    off += 1 + len;
  }
  return { name: labels.join("."), next: next === -1 ? off : next };
}

/** 测试导出:把一个 mDNS 应答包解成 {ptr, srv, a, txt}。坏包静默返回空。 */
function parsePacket(buf) {
  const out = { ptr: [], srv: {}, a: {}, txt: {} };
  try {
    if (buf.length < 12) return out;
    const qd = buf.readUInt16BE(4);
    const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    let off = 12;
    for (let i = 0; i < qd; i++) { off = decodeName(buf, off).next + 4; } // 跳过问题区
    for (let i = 0; i < total && off < buf.length; i++) {
      const { name, next } = decodeName(buf, off);
      if (next + 10 > buf.length) break;
      const type = buf.readUInt16BE(next);
      const rdlen = buf.readUInt16BE(next + 8);
      const rdOff = next + 10;
      if (rdOff + rdlen > buf.length) break;
      if (type === 12) {
        out.ptr.push(decodeName(buf, rdOff).name);
      } else if (type === 33 && rdlen >= 7) {
        out.srv[name] = { target: decodeName(buf, rdOff + 6).name, port: buf.readUInt16BE(rdOff + 4) };
      } else if (type === 1 && rdlen === 4) {
        out.a[name] = Array.from(buf.subarray(rdOff, rdOff + 4)).join(".");
      } else if (type === 16) {
        const txts = [];
        let t = rdOff;
        while (t < rdOff + rdlen) { const l = buf[t]; txts.push(buf.subarray(t + 1, t + 1 + l).toString("utf8")); t += 1 + l; }
        out.txt[name] = txts;
      }
      off = rdOff + rdlen;
    }
  } catch { /* 坏包忽略 */ }
  return out;
}

function scan({ timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const found = { ptr: new Set(), srv: {}, a: {}, txt: {} };
    let sock;
    try {
      sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve([]);
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* ignore */ }
      const list = [];
      for (const inst of found.ptr) {
        if (!inst.toLowerCase().endsWith(SERVICE)) continue;
        const srv = found.srv[inst];
        if (!srv) continue;
        const host = found.a[srv.target] || srv.target.replace(/\.$/, "");
        const name = inst.slice(0, inst.length - SERVICE.length - 1);
        list.push({ name, host, port: srv.port, url: `ws://${host}:${srv.port}` });
      }
      list.sort((x, y) => x.name.localeCompare(y.name));
      resolve(list);
    };
    sock.on("error", finish);
    sock.on("message", (msg) => {
      const p = parsePacket(msg);
      p.ptr.forEach((x) => found.ptr.add(x));
      Object.assign(found.srv, p.srv);
      Object.assign(found.a, p.a);
      Object.assign(found.txt, p.txt);
    });
    sock.bind(MDNS_PORT, () => {
      try { sock.addMembership(MDNS_ADDR); } catch { /* 已有成员或无权限,收单播答复也行 */ }
      const q = buildQuery();
      setTimeout(finish, timeoutMs); // 先武装收尾定时器:发送若同步抛出也不会让 Promise 悬着
      try { sock.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR); } catch { /* ignore */ }
      setTimeout(() => { if (!settled) { try { sock.send(q, 0, q.length, MDNS_PORT, MDNS_ADDR); } catch { /* ignore */ } } }, 1000);
    });
  });
}

/** 浏览局域网 OpenClaw 网关;结果缓存 5s(向导轮询/重复点开不放大扫描)。 */
async function browseOpenclawGateways(opts = {}) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await scan(opts);
  cache = { at: Date.now(), value };
  return value;
}
// 测试用:绕缓存直扫。
browseOpenclawGateways.uncached = (opts) => scan(opts);

module.exports = { browseOpenclawGateways, _parsePacket: parsePacket };
