"use strict";

// A test-only interpreter wrapper executes the actual bundled Python CLI with
// urllib and socket transport blocked. No fixture switch enters production code.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { resolveOnPath } = require("../../app/agent-service/mcp-package-launcher");

function createFlightawareFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flightaware-connector-")); fs.chmodSync(root, 0o700);
  const bin = path.join(root, "bin"), callsFile = path.join(root, "calls.jsonl"); fs.mkdirSync(bin, { mode: 0o700 });
  const python = resolveOnPath("python3");
  const bootstrap = `import base64, io, json, os, socket, sys, time, urllib.error, urllib.parse, urllib.request
from unittest.mock import patch
source = sys.argv[1]
assert 'UNRELATED_SECRET' not in os.environ
assert os.environ.get('FLIGHTAWARE_API_KEY') not in source
sys.argv = ['flightaware'] + sys.argv[2:]
def fake_open(self, req, *args, **kwargs):
    url = urllib.parse.urlsplit(req.full_url)
    query = urllib.parse.parse_qs(url.query)
    assert url.scheme == 'https' and url.hostname == 'aeroapi.flightaware.com'
    assert url.path.startswith('/aeroapi/') and req.get_method() == 'GET'
    key = req.get_header('X-apikey')
    assert key == os.environ.get('FLIGHTAWARE_API_KEY') and 'apikey' not in query
    with open(${JSON.stringify(callsFile)}, 'a', encoding='utf-8') as output:
        output.write(json.dumps({'method': req.get_method(), 'path': url.path, 'query': query, 'key_in_header': bool(key)}) + '\\n')
    if key == 'fixture-slow':
        time.sleep(20)
    if key in ('fixture-unauthorized', 'fixture-forbidden', 'fixture-rate-limit', 'fixture-redirect'):
        status = {'fixture-unauthorized': 401, 'fixture-forbidden': 403, 'fixture-rate-limit': 429, 'fixture-redirect': 302}[key]
        raise urllib.error.HTTPError(req.full_url, status, 'fixture', {'Location': 'https://untrusted.invalid/'}, io.BytesIO(('secret=' + key).encode()))
    if key == 'fixture-network-error':
        raise urllib.error.URLError('fixture secret=' + key)
    if key == 'fixture-invalid-json':
        return io.BytesIO(b'not json')
    if key == 'fixture-wrong-shape':
        return io.BytesIO(b'{}')
    if key == 'fixture-oversized':
        return io.BytesIO(b' ' * (4 * 1024 * 1024 + 2))
    flight = {'ident': 'UAL123', 'fa_flight_id': 'UAL123-1793232000-airline-0001', 'status': 'Scheduled', 'origin': {'code_icao': 'KJFK'}, 'destination': {'code_icao': 'KLAX'}, 'cancelled': False, 'scheduled_out': '2026-11-01T12:00:00Z'}
    point = {'latitude': 40.64, 'longitude': -73.78, 'altitude': 300, 'timestamp': '2026-11-01T12:05:00Z'}
    suffix = url.path.removeprefix('/aeroapi/')
    if suffix == 'account/usage':
        data = {'total_calls': 2, 'total_cost': 0.01, 'start': '2026-10-01T00:00:00Z', 'end': '2026-11-01T00:00:00Z'}
    elif suffix.endswith('/map'):
        data = {'map': 'invalid===' if key == 'fixture-invalid-map' else 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1UAAAAASUVORK5CYII='}
    elif suffix.endswith('/position'):
        data = {'last_position': point}
    elif suffix.endswith('/track'):
        data = {'actual_distance': 10, 'positions': [point] * (1200 if key == 'fixture-long-track' else 2)}
    elif suffix.endswith('/route'):
        data = {'route_distance': 2500, 'fixes': [{'name': 'FIXTURE', 'latitude': 40.64, 'longitude': -73.78}]}
    elif suffix.endswith('/canonical'):
        data = {'idents': [{'ident': 'UAL123', 'ident_type': 'designator'}]}
    elif suffix.startswith('schedules/'):
        data = {'scheduled': [flight], 'num_pages': 1, 'links': {'next': None}}
    elif suffix.startswith('flights/'):
        data = {'flights': [flight], 'num_pages': 1, 'links': {'next': '/aeroapi/flights/UAL123?cursor=fixture-next'}}
    elif '/flights/counts' in suffix:
        data = {'departed': 1, 'enroute': 2, 'scheduled_arrivals': 3, 'scheduled_departures': 4}
    elif '/flights' in suffix:
        kind = suffix.rsplit('/', 1)[-1]
        kind = 'flights' if kind == 'flights' else kind
        data = {kind: [flight], 'num_pages': 1, 'links': {'next': None}}
    elif '/weather/observations' in suffix:
        data = {'observations': [{'raw_data': 'KJFK fixture METAR'}]}
    elif '/weather/forecast' in suffix:
        data = {'raw_forecast': 'KJFK fixture TAF'}
    elif suffix.endswith('/delays'):
        data = {'delays': [{'airport': 'KJFK', 'delay_secs': 300}]}
    elif suffix.startswith('airports/'):
        data = {'airport_code': 'KJFK', 'code_icao': 'KJFK', 'name': 'Fixture Airport'}
    elif suffix.startswith('operators/'):
        data = {'icao': 'UAL', 'name': 'Fixture Airline'}
    elif suffix.endswith('/blocked'):
        data = {'blocked': False}
    elif suffix.endswith('/owner'):
        data = {'owner': {'name': 'Fixture Owner'}}
    else:
        data = {'disruptions': [{'airport': 'KJFK', 'cancelled': 1}]}
    data['fixture_echo'] = key
    return io.BytesIO(json.dumps(data).encode())
with patch.object(urllib.request.OpenerDirector, 'open', fake_open), patch.object(socket.socket, 'connect', side_effect=AssertionError('network blocked')), patch.object(socket.socket, 'connect_ex', side_effect=AssertionError('network blocked')):
    exec(compile(source, '<bundled-flightaware>', 'exec'), {'__name__': '__main__'})
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

module.exports = { createFlightawareFixture };
