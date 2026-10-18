import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

const BASE = __ENV.TARGET;                      // e.g. http://your-api.railway.internal:8080
const SCALE = parseFloat(__ENV.SCALE || '1');   // multiply all rates (0.1 for a smoke test)
// k6 needs integer rates, so rates are expressed per minute and rounded
const R = (perSec) => Math.max(1, Math.round(perSec * 60 * SCALE));

// data.json: { stops: [..], lines: [{linea, trayecto, sentido}], metroStops: [..], metroRoutes: [{route, direction}], notifications: [..] }
const data = new SharedArray('data', () => [JSON.parse(open('./data.json'))])[0];

// Tenerife centre points for "nearby stops" (Santa Cruz, La Laguna, Costa Adeje, Puerto de la Cruz)
const HOTSPOTS = [
  [28.4636, -16.2518], [28.4874, -16.3159], [28.0890, -16.7270], [28.4143, -16.5470],
];

const rnd = (a, b) => a + Math.random() * (b - a);
const think = (a, b) => sleep(rnd(a, b));
// Skewed pick: low indexes (hot stops / popular lines) get most of the traffic
const hot = (arr) => arr[Math.floor(Math.pow(Math.random(), 2.5) * arr.length)];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const get = (path, name) => http.get(`${BASE}${path}`, { tags: { endpoint: name } });
const ok = (r, name) => check(r, { [`${name} 200`]: (x) => x.status === 200 });
// The API can answer 200 with {"success":false}; that is a data failure, not a pass
const okData = (r, name) => check(r, {
  [`${name} success:true`]: (x) => { try { return x.json('success') === true; } catch (e) { return false; } },
});

export const options = {
  scenarios: {
    // Main behaviour: open app -> nearby stops -> watch arrivals at one stop, refreshing
    bus_arrivals: {
      executor: 'ramping-arrival-rate', exec: 'busArrivals',
      startRate: R(1), timeUnit: '1m', preAllocatedVUs: 500, maxVUs: 4000,
      stages: [
        { target: R(5), duration: '2m' },
        { target: R(15), duration: '5m' },
        { target: R(30), duration: '5m' },
        { target: 0, duration: '1m' },
      ],
    },
    // Planners: browse lines, stops of a line, itinerary (heavier, less frequent)
    line_browsing: {
      executor: 'constant-arrival-rate', exec: 'lineBrowsing',
      rate: R(3), timeUnit: '1m', duration: '13m',
      preAllocatedVUs: 100, maxVUs: 800,
    },
    // Cold app opens: just the cacheable list endpoint
    app_open: {
      executor: 'constant-arrival-rate', exec: 'appOpen',
      rate: R(2), timeUnit: '1m', duration: '13m',
      preAllocatedVUs: 50, maxVUs: 300,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{endpoint:titsa_llegadas}': ['p(95)<800'],
    'http_req_duration{endpoint:titsa_cercanas}': ['p(95)<800'],
    'http_req_duration{endpoint:titsa_parada}': ['p(95)<600'],
    'http_req_duration{endpoint:titsa_lineas}': ['p(95)<500'],
    'http_req_duration{endpoint:titsa_paradas_linea}': ['p(95)<600'],
    'http_req_duration{endpoint:titsa_itinerario}': ['p(95)<800'],
    dropped_iterations: ['count<100'],
  },
};

export function busArrivals() {
  const [lat, lng] = pick(HOTSPOTS);
  const radio = pick([200, 300, 500]);
  const cercanas = get(`/titsa/cercanas?lat=${(lat + rnd(-0.01, 0.01)).toFixed(5)}&lng=${(lng + rnd(-0.01, 0.01)).toFixed(5)}&radio=${radio}`, 'titsa_cercanas');
  ok(cercanas, 'cercanas');
  think(2, 6);

  const stop = hot(data.stops);
  if (Math.random() < 0.3) {
    const p = get(`/titsa/parada/${stop}`, 'titsa_parada');
    ok(p, 'parada'); okData(p, 'parada');
    think(1, 3);
  }

  // User stares at the arrivals screen, which auto-refreshes
  const refreshes = 2 + Math.floor(Math.random() * 5);
  for (let i = 0; i < refreshes; i++) {
    const l = get(`/titsa/llegadas/${stop}`, 'titsa_llegadas');
    ok(l, 'llegadas'); okData(l, 'llegadas');
    think(15, 30);
  }

  if (Math.random() < 0.1) { ok(get(`/titsa/notificacion/${pick(data.notifications)}`, 'titsa_notificacion'), 'notificacion'); }
}

export function metroSession() {
  const stop = hot(data.metroStops);
  const refreshes = 1 + Math.floor(Math.random() * 4);
  for (let i = 0; i < refreshes; i++) {
    ok(get(`/metro/llegadas?stopSAE=${stop}`, 'metro_llegadas'), 'metro llegadas');
    think(15, 30);
  }
  if (Math.random() < 0.15) {
    const r = pick(data.metroRoutes);
    ok(get(`/metro/itinerario?route=${r.route}&direction=${r.direction}`, 'metro_itinerario'), 'metro itinerario');
  }
}

export function lineBrowsing() {
  ok(get('/titsa/lineas', 'titsa_lineas'), 'lineas');
  think(2, 5);
  const l = hot(data.lines);
  ok(get(`/titsa/paradas?linea=${l.linea}&sentido=${l.sentido}`, 'titsa_paradas_linea'), 'paradas');
  think(2, 6);
  const it = get(`/titsa/itinerario?linea=${l.linea}&trayecto=${l.trayecto}`, 'titsa_itinerario');
  ok(it, 'itinerario'); okData(it, 'itinerario');
  think(1, 3);
}

export function appOpen() {
  ok(get('/titsa/lineas', 'titsa_lineas'), 'lineas');
  think(1, 2);
}
