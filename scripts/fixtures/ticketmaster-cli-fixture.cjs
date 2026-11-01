"use strict";

// A test-only interpreter wrapper executes the actual bundled Python CLI with
// urllib and socket transport blocked. No fixture switch enters production code.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { resolveOnPath } = require("../../app/agent-service/mcp-package-launcher");

function createTicketmasterFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ticketmaster-connector-")); fs.chmodSync(root, 0o700);
  const bin = path.join(root, "bin"), callsFile = path.join(root, "calls.jsonl"); fs.mkdirSync(bin, { mode: 0o700 });
  const python = resolveOnPath("python3");
  const bootstrap = `import io, json, os, socket, sys, time, urllib.error, urllib.parse, urllib.request
from unittest.mock import patch
source = sys.argv[1]
assert 'UNRELATED_SECRET' not in os.environ
assert os.environ.get('TICKETMASTER_API_KEY') not in source
sys.argv = ['ticketmaster'] + sys.argv[2:]
def fake_open(self, req, *args, **kwargs):
    url = urllib.parse.urlsplit(req.full_url)
    query = urllib.parse.parse_qs(url.query)
    assert url.scheme == 'https' and url.hostname == 'app.ticketmaster.com'
    assert url.path.startswith('/discovery/v2/') and req.get_method() == 'GET'
    key = query.get('apikey', [''])[0]
    assert key == os.environ.get('TICKETMASTER_API_KEY')
    with open(${JSON.stringify(callsFile)}, 'a', encoding='utf-8') as output:
        output.write(json.dumps({'method': req.get_method(), 'path': url.path, 'query': {name: values for name, values in query.items() if name != 'apikey'}, 'key_in_environment': bool(key)}) + '\\n')
    if key == 'fixture-slow':
        time.sleep(20)
    if key in ('fixture-unauthorized', 'fixture-forbidden', 'fixture-rate-limit'):
        status = {'fixture-unauthorized': 401, 'fixture-forbidden': 403, 'fixture-rate-limit': 429}[key]
        raise urllib.error.HTTPError(req.full_url, status, 'fixture', {'Rate-Limit-Reset': '1793289600000'}, io.BytesIO(('secret=' + key).encode()))
    if key == 'fixture-network-error':
        raise urllib.error.URLError('fixture secret=' + key)
    if key == 'fixture-invalid-json':
        return io.BytesIO(b'not json')
    if key == 'fixture-wrong-shape':
        return io.BytesIO(b'{"wrong": true}')
    image = {'url': 'https://s1.ticketm.net/dam/a/fixture.jpg?apikey=' + key, 'width': 1024, 'height': 576, 'ratio': '16_9', 'fallback': False}
    venue = {'id': 'fixture-venue', 'name': 'Fixture Hall', 'city': {'name': 'Fixture City'}, 'country': {'countryCode': 'US'}, 'images': [image]}
    attraction = {'id': 'fixture-artist', 'name': 'Fixture Singer', 'images': [image]}
    event = {'id': 'fixture-event', 'name': 'Fixture Concert', 'type': 'event', 'url': 'https://www.ticketmaster.com/event/fixture-event', 'images': [image], 'priceRanges': [{'currency': 'USD', 'min': 20, 'max': 80}], 'dates': {'start': {'localDate': '2026-11-01', 'localTime': '19:30:00'}, 'status': {'code': 'onsale'}}, 'seatmap': {'staticUrl': 'https://s1.ticketm.net/fixture-map.png'}, '_embedded': {'venues': [venue], 'attractions': [attraction]}}
    if '/events/' in url.path:
        data = event
    else:
        kind = 'venues' if url.path.endswith('/venues.json') else 'attractions' if url.path.endswith('/attractions.json') else 'events'
        item = venue if kind == 'venues' else attraction if kind == 'attractions' else event
        data = {'_embedded': {kind: [item]}, 'page': {'size': int(query.get('size', ['10'])[0]), 'number': int(query.get('page', ['0'])[0]), 'totalElements': 1, 'totalPages': 1}, '_links': {'self': {'href': req.full_url}}}
    return io.BytesIO(json.dumps(data).encode())
with patch.object(urllib.request.OpenerDirector, 'open', fake_open), patch.object(socket.socket, 'connect', side_effect=AssertionError('network blocked')):
    exec(compile(source, '<bundled-ticketmaster>', 'exec'), {'__name__': '__main__'})
`;
  const wrapper = `#!${process.execPath}
"use strict";
const {spawn}=require("node:child_process");
const args=process.argv.slice(2);
if(args[0]!=="-I"||args[1]!=="-B"||args[2]!=="-c")process.exit(90);
const child=spawn(${JSON.stringify(python)},["-I","-B","-c",${JSON.stringify(bootstrap)},...args.slice(3)],{env:process.env,stdio:["ignore","inherit","inherit"],shell:false});
for(const signal of ["SIGTERM","SIGINT"])process.once(signal,()=>child.kill(signal));
child.once("error",()=>{process.exitCode=91;});
child.once("exit",code=>{process.exitCode=code===null?130:code;});
`;
  const interpreter = path.join(bin, "python3"); fs.writeFileSync(interpreter, wrapper, { mode: 0o700 });
  const env = { ...process.env, HOME: root, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}` };
  return { root, bin, interpreter, env, callsFile,
    calls: () => fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [],
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

module.exports = { createTicketmasterFixture };
