#!/usr/bin/env python3
"""Local CONNECT fault fixture; forwards encrypted bytes, never intercepts TLS.

Example: --port 17897 --upstream-port 7897 --fail-connects 1,2 --cut-connect 6
Point ONLY an isolated validation app's http(s)_proxy at this fixture.
The first two update-host tunnels close before TLS. Tunnel six closes after
64 KiB of server bytes (the expected first package transfer). All other bytes
are forwarded unchanged, retaining the client's real certificate/signature checks.
The fixture never changes system proxy settings. No third-party dependency.
"""
import argparse
import json
import select
import socket
import socketserver
import threading

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--port', type=int, default=17897)
parser.add_argument('--upstream-port', type=int, default=7897)
parser.add_argument('--fail-connects', default='1,2')
parser.add_argument('--cut-connect', type=int, default=6)
parser.add_argument('--cut-first-transfer', action='store_true', help='Cut the first tunnel exceeding 64 KiB, independent of connection count')
args = parser.parse_args()
fail = {int(n) for n in args.fail_connects.split(',') if n}
lock = threading.Lock()
count = 0
cut_done = False


def headers(sock):
    data = b''
    while b'\r\n\r\n' not in data and len(data) < 16384:
        chunk = sock.recv(1)
        if not chunk:
            raise ConnectionError('incomplete proxy headers')
        data += chunk
    return data


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        global count, cut_done
        self.request.settimeout(30)
        try:
            request = headers(self.request)
            first = request.split(b'\r\n', 1)[0]
            if first != b'CONNECT download.sourceweft.com:443 HTTP/1.1':
                self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
                return
            with lock:
                count += 1
                number = count
            print(json.dumps({'connection': number, 'event': 'connect'}), flush=True)
            if number in fail:
                self.request.sendall(b'HTTP/1.1 200 Connection established\r\n\r\n')
                print(json.dumps({'connection': number, 'event': 'injected_tls_eof'}), flush=True)
                return
            with socket.create_connection(('127.0.0.1', args.upstream_port), timeout=15) as upstream:
                upstream.sendall(request)
                response = headers(upstream)
                self.request.sendall(response)
                if b' 200 ' not in response.split(b'\r\n', 1)[0]:
                    return
                received = 0
                while True:
                    readable, _, _ = select.select([self.request, upstream], [], [], 30)
                    if not readable:
                        return
                    for source in readable:
                        data = source.recv(16384)
                        if not data:
                            return
                        target = self.request if source is upstream else upstream
                        target.sendall(data)
                        if source is upstream:
                            received += len(data)
                            with lock:
                                cut = received >= 65536 and not cut_done and (args.cut_first_transfer or number == args.cut_connect)
                                if cut:
                                    cut_done = True
                            if cut:
                                print(json.dumps({'connection': number, 'event': 'injected_transfer_eof', 'encryptedBytes': received}), flush=True)
                                return
        except (OSError, ConnectionError) as error:
            print(json.dumps({'event': 'connection_error', 'type': type(error).__name__}), flush=True)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


with Server(('127.0.0.1', args.port), Handler) as server:
    print(json.dumps({'event': 'listening', 'port': args.port}), flush=True)
    server.serve_forever()
