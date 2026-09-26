// Throwaway probe: does Netts accept calls from Render's outbound IPs?
// Deploy as a free Render web service, read the logs, then delete the service.
import http from 'node:http';

const KEY = process.env.NETTS_API_KEY;
let last = 'starting';

async function probe() {
  try {
    const ip = (await (await fetch('https://api.ipify.org')).text()).trim();
    const res = await fetch('https://netts.io/apiv2/userinfo', {
      headers: { 'X-API-KEY': KEY, 'X-Real-IP': ip },
    });
    const body = await res.text();
    const ok = res.ok && body.includes('"success"');
    last = `${new Date().toISOString()} egress=${ip} http=${res.status} ok=${ok}`;
    console.log(last, ok ? '' : body.slice(0, 200));
  } catch (e) {
    last = `${new Date().toISOString()} error=${e.message}`;
    console.log(last);
  }
}

probe();
setInterval(probe, 60_000);
// Render free web services need an open port; show only the summary line, never the key or balance.
http.createServer((_, res) => res.end(last + '\n')).listen(process.env.PORT || 3000);
