#!/usr/bin/env python3
"""Production transport binding tests; no Host or remote-provider claim."""
import sys

# Import the production adapter without changing its exact three-file tree.
sys.dont_write_bytecode = True

import importlib.util
import json
import os
import pathlib
import pwd
import socket
import tempfile
import threading

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'resources/external-plugin-adapters/hermes/transport.py'
KEYS = ('SHOGGOTH_HERMES_MANAGED_CONTROL_FILE', 'SHOGGOTH_SERVICE_USER_DATA_ROOT', 'HERMES_HOME')
original = {key: os.environ.get(key) for key in KEYS}
cases = []


def load():
    spec = importlib.util.spec_from_file_location('_hermes_service_root_' + str(len(cases)), SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def rejected(action):
    try:
        action()
    except (RuntimeError, OSError, ValueError, TypeError):
        return
    raise AssertionError('Unsafe binding was accepted')


try:
    with tempfile.TemporaryDirectory(prefix='sgh-hermes-root-', dir='/private/tmp') as temp:
        root = pathlib.Path(temp).resolve()
        os.chmod(root, 0o700)
        home = root / 'owned-host'
        service = root / 'actual-service'
        other = root / 'other-service'
        for folder in (home, service, other):
            folder.mkdir(mode=0o700)
        control = home / 'managed-control.json'
        descriptor = {'version': 1, 'backend_id': 'hermes',
                      'runtime_root': str(pathlib.Path(sys.executable).resolve().parent),
                      'runtime_tree_sha256': 'a' * 64, 'data_root': str(home),
                      'nonce': 'b' * 64, 'control_token': 'c' * 64,
                      'required_adapter_id': 'shoggoth_shared_capabilities',
                      'adapter_tree_sha256': 'd' * 64}
        control.write_text(json.dumps(descriptor))
        os.chmod(control, 0o600)
        os.environ.pop(KEYS[0], None)
        os.environ[KEYS[1]] = str(service)
        legacy = load()
        assert legacy._root() == pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / 'Library/Application Support/Shoggoth'
        cases.append('legacy ignores a root-only environment override')
        os.environ[KEYS[0]] = str(control)
        os.environ[KEYS[2]] = str(home)
        for value in (None, '', 'relative', str(service) + '/..'):
            if value is None:
                os.environ.pop(KEYS[1], None)
            else:
                os.environ[KEYS[1]] = value
            rejected(load)
        os.environ[KEYS[1]] = str(service)
        cases.append('managed missing/empty/relative/noncanonical roots fail at import')
        link = root / 'root-link'
        link.symlink_to(service, target_is_directory=True)
        os.environ[KEYS[1]] = str(link)
        rejected(load)
        os.environ[KEYS[1]] = str(service)
        os.chmod(service, 0o755)
        rejected(load)
        os.chmod(service, 0o700)
        cases.append('symlink and nonprivate Service roots fail before IPC')
        for change in ({'version': True}, {'backend_id': 'openclaw'}, {'data_root': str(other)}, {'runtime_root': str(other)}, {'extra': True}):
            control.write_text(json.dumps({**descriptor, **change}))
            rejected(load)
        control.write_text(json.dumps(descriptor))
        control.rename(home / 'original-control.json')
        control.symlink_to(home / 'original-control.json')
        rejected(load)
        control.unlink()
        (home / 'original-control.json').rename(control)
        cases.append('exact protected descriptor, actual executable owner and HERMES_HOME bind managed override')
        managed = load()
        os.environ[KEYS[1]] = str(other)
        os.environ.pop(KEYS[0], None)
        os.environ[KEYS[2]] = str(other)
        assert managed._root() == service
        cases.append('import-time profile root remains immutable after environment mutation')
        core = service / 'shoggoth-core'
        run = service / 'run'
        core.mkdir(mode=0o700)
        run.mkdir(mode=0o700)
        credential = core / 'external-plugin-hermes.auth.json'
        credential.write_text(json.dumps({'schemaVersion': 1, 'token': 'x' * 43}))
        os.chmod(credential, 0o600)
        assert managed.read_credential() == 'x' * 43
        sock_path = run / 'service.sock'
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(sock_path))
        os.chmod(sock_path, 0o600)
        listener.listen(1)
        seen = []
        errors = []
        def respond():
            try:
                connection, _ = listener.accept()
                with connection:
                    data = bytearray()
                    while not data.endswith(b'\n'):
                        data.extend(connection.recv(4096))
                    request = json.loads(data)
                    seen.append({'method': request['method'], 'version': request['version']})
                    connection.sendall((json.dumps({'id': request['id'], 'ok': True, 'result': {'actualSocket': True}}) + '\n').encode())
            except Exception as error:
                errors.append(type(error).__name__)
        thread = threading.Thread(target=respond, daemon=True)
        thread.start()
        assert managed.request_service('plugin.external.selection.bind', {}) == {'actualSocket': True}
        thread.join(3)
        listener.close()
        assert not thread.is_alive() and not errors
        assert seen == [{'method': 'plugin.external.selection.bind', 'version': 11}]
        cases.append('unchanged production request frame reaches only the bound private UNIX socket')
        credential.rename(core / 'original.auth')
        credential.symlink_to(core / 'original.auth')
        rejected(managed.read_credential)
        credential.unlink()
        (core / 'original.auth').rename(credential)
        os.chmod(credential, 0o644)
        rejected(managed.read_credential)
        os.chmod(credential, 0o600)
        run.rename(service / 'original-run')
        run.symlink_to(service / 'original-run', target_is_directory=True)
        rejected(lambda: managed.request_service('never_sent', {}))
        run.unlink()
        (service / 'original-run').rename(run)
        cases.append('credential and child-directory ACL/no-follow boundaries remain enforced')
        service.rename(root / 'retired-service')
        service.mkdir(mode=0o700)
        rejected(managed._root)
        cases.append('same path replacement cannot reuse the captured Service root inode')
    print(json.dumps({'status': 'PASS', 'groups': len(cases), 'cases': cases, 'hostStarts': 0, 'remoteRequests': 0}))
finally:
    for key, value in original.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
