"""
Local dev server: static files + reverse proxy to the Flask evolution API.

Usage:
    1. Start the API:   cd games/football/api && python app.py
    2. Start this:      python dev-server.py
    3. Open:            http://localhost:8000
"""
import http.server
import urllib.request
import os

API = "http://127.0.0.1:5050"
PORT = 8000
DIR = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)

    def do_GET(self):
        if self.path.startswith("/api/football"):
            self._proxy()
        else:
            super().do_GET()

    def do_POST(self):
        self._proxy()

    def _proxy(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(
            API + self.path,
            data=body,
            headers={"Content-Type": self.headers.get("Content-Type", "application/json")},
            method=self.command,
        )
        try:
            with urllib.request.urlopen(req) as resp:
                self.send_response(resp.status)
                self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                self.end_headers()
                self.wfile.write(resp.read())
        except Exception as e:
            self.send_error(502, str(e))


if __name__ == "__main__":
    print(f"Dev server at http://localhost:{PORT}")
    http.server.HTTPServer(("", PORT), Handler).serve_forever()
