import http from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * Minimal HTTP loopback server used by OAuth flows that the app itself
 * initiates (future use for native Google APIs that we might add). It spins
 * up a one-shot server on 127.0.0.1 with a random high port, waits for the
 * callback, and tears itself down.
 *
 * Not currently wired into any flow (the MVP delegates Google login to the
 * system browser entirely) but kept as a hook for when we implement our
 * own OAuth client (e.g. account sync across devices).
 */
export type LoopbackResult = {
  url: URL;
  params: URLSearchParams;
};

export async function awaitLoopbackCallback(
  pathPrefix = '/oauth-callback',
  timeoutMs = 2 * 60 * 1000,
): Promise<{ port: number; result: Promise<LoopbackResult> }> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const result = new Promise<LoopbackResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OAuth callback timed out'));
    }, timeoutMs);

    server.on('request', (req, res) => {
      if (!req.url || !req.url.startsWith(pathPrefix)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Voksa</title>' +
          '<style>body{font-family:system-ui;display:grid;place-items:center;height:100vh;background:#fafbfc;color:#1a1d23}</style>' +
          '<div><h2>Authentification terminée</h2><p>Vous pouvez fermer cet onglet.</p></div>',
      );
      clearTimeout(timer);
      server.close();
      resolve({ url, params: url.searchParams });
    });
  });

  return { port, result };
}
