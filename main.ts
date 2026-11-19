// main.ts — entrypoint. Boot the forge on an ephemeral port, tell the
// harness where it listens, then wait until the harness says the trial is
// done and exit cleanly.
//
// The harness drives everything: it sets MAKEFUN_ENV_URL (its own control
// endpoint) and MAKEFUN_SHOP_TOKEN (the only credential). There is no
// configuration file and no other way in.

import { createApp } from './app.ts';
import { Store } from './store.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set; nothing to register with');
  process.exit(1);
}

const store = new Store();
const server = createApp(store);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function postJson(url: string, payload: unknown, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string, timeoutMs = 5000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function register(port: number): Promise<void> {
  // The harness may not be listening the instant we boot; back off and
  // retry rather than dying on the first refused connection.
  let delay = 100;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await postJson(`${envUrl}/register`, { port });
      if (response.ok) return;
      console.error(`register attempt ${attempt + 1} answered HTTP ${response.status}`);
    } catch (err) {
      console.error(`register attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 5000);
  }
  throw new Error('could not register with the harness after 30 attempts');
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const body = (await getJson(`${envUrl}/done`)) as { done?: boolean };
      if (body.done === true) return;
    } catch (err) {
      console.error(`done poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(500);
  }
}

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    console.error('server did not bind to a port');
    process.exit(1);
  }
  const port = address.port;
  console.log(`forge listening on 127.0.0.1:${port}`);
  void (async () => {
    try {
      await register(port);
      await waitForDone();
      console.log('trial done, shutting down');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  })();
});

server.on('error', (err) => {
  console.error(`server error: ${err.message}`);
  process.exit(1);
});
