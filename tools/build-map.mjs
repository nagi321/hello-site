// Builds map-data.js: SVG land paths and projected city positions for the two maps.
//
// Data: Natural Earth (public domain), distributed as TopoJSON by the world-atlas package.
// Usage: node tools/build-map.mjs countries-50m.json > map-data.js
import { readFileSync } from 'node:fs';

const MAPS = {
  japan: {
    width: 1000,
    bounds: { lonMin: 128.4, lonMax: 142.6, latMin: 30.4, latMax: 38.6 },
    tolerance: 0.45,
    // [latitude, longitude]
    points: {
      '東京': [35.681, 139.767],
      '名古屋': [35.170, 136.882],
      '新大阪': [34.733, 135.500],
      '岡山': [34.666, 133.918],
      '広島': [34.398, 132.475],
      '博多': [33.590, 130.421],
      '熊本': [32.790, 130.689],
      '鹿児島中央': [31.584, 130.542],
    },
  },
  world: {
    width: 1200,
    // about the same aspect ratio as the Japan map (7:5), so both fit the same frame
    bounds: { lonMin: -20, lonMax: 150, latMin: -20, latMax: 70 },
    tolerance: 0.5,
    points: {
      '東京': [35.681, 139.767],
      '大阪': [34.694, 135.502],
      '福岡': [33.590, 130.401],
      'ソウル': [37.567, 126.978],
      '上海': [31.230, 121.474],
      '香港': [22.320, 114.170],
      'バンコク': [13.756, 100.502],
      'シンガポール': [1.352, 103.820],
      'ドバイ': [25.205, 55.271],
      'パリ': [48.857, 2.352],
    },
  },
};

const RAD = Math.PI / 180;
const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

function makeProjection({ width, bounds }) {
  const scale = width / ((bounds.lonMax - bounds.lonMin) * RAD);
  const yTop = merc(bounds.latMax);
  const height = Math.round((yTop - merc(bounds.latMin)) * scale);
  const project = ([lon, lat]) => [(lon - bounds.lonMin) * RAD * scale, (yTop - merc(lat)) * scale];
  return { height, project };
}

// ---- TopoJSON decoding ----
function decodeArcs(topo) {
  const { scale, translate } = topo.transform;
  return topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
}

function ringPoints(arcs, indices) {
  const points = [];
  for (const index of indices) {
    const arc = index >= 0 ? arcs[index] : [...arcs[~index]].reverse();
    points.push(...(points.length ? arc.slice(1) : arc));
  }
  return points;
}

function allRings(topo, arcs) {
  const rings = [];
  for (const geometry of topo.objects.countries.geometries) {
    const polygons = geometry.type === 'Polygon' ? [geometry.arcs] : geometry.type === 'MultiPolygon' ? geometry.arcs : [];
    for (const polygon of polygons) {
      for (const ring of polygon) rings.push(ringPoints(arcs, ring));
    }
  }
  return rings;
}

// ---- Sutherland-Hodgman clipping to a lon/lat rectangle ----
function clipRing(ring, box) {
  const edges = [
    { inside: (p) => p[0] >= box.lonMin, cut: (a, b) => lerpAt(a, b, 0, box.lonMin) },
    { inside: (p) => p[0] <= box.lonMax, cut: (a, b) => lerpAt(a, b, 0, box.lonMax) },
    { inside: (p) => p[1] >= box.latMin, cut: (a, b) => lerpAt(a, b, 1, box.latMin) },
    { inside: (p) => p[1] <= box.latMax, cut: (a, b) => lerpAt(a, b, 1, box.latMax) },
  ];
  let output = ring;
  for (const edge of edges) {
    const input = output;
    output = [];
    if (input.length === 0) break;
    for (let i = 0; i < input.length; i += 1) {
      const current = input[i];
      const previous = input[(i + input.length - 1) % input.length];
      if (edge.inside(current)) {
        if (!edge.inside(previous)) output.push(edge.cut(previous, current));
        output.push(current);
      } else if (edge.inside(previous)) {
        output.push(edge.cut(previous, current));
      }
    }
  }
  return output;
}

function lerpAt(a, b, axis, value) {
  const t = (value - a[axis]) / (b[axis] - a[axis]);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function area(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

function buildMap(topoRings, spec) {
  const { height, project } = makeProjection(spec);
  const margin = 0.5;
  const box = {
    lonMin: spec.bounds.lonMin - margin,
    lonMax: spec.bounds.lonMax + margin,
    latMin: spec.bounds.latMin - margin,
    latMax: spec.bounds.latMax + margin,
  };

  let path = '';
  for (const ring of topoRings) {
    const clipped = clipRing(ring, box);
    if (clipped.length < 3) continue;

    // project, then drop points closer than the tolerance
    const kept = [];
    for (const point of clipped.map(project)) {
      const last = kept[kept.length - 1];
      if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) >= spec.tolerance) kept.push(point);
    }
    if (kept.length < 3 || area(kept) < 2) continue;

    // tenths of a unit, written as relative moves
    const tenths = kept.map(([x, y]) => [Math.round(x * 10), Math.round(y * 10)]);
    path += `M${tenths[0][0] / 10} ${tenths[0][1] / 10}l`;
    const moves = [];
    for (let i = 1; i < tenths.length; i += 1) {
      moves.push(`${(tenths[i][0] - tenths[i - 1][0]) / 10} ${(tenths[i][1] - tenths[i - 1][1]) / 10}`);
    }
    path += `${moves.join(' ')}z`;
  }

  const points = {};
  for (const [name, [lat, lon]] of Object.entries(spec.points)) {
    const [x, y] = project([lon, lat]);
    points[name] = [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  }
  return { width: spec.width, height, land: path, points };
}

const topo = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const rings = allRings(topo, decodeArcs(topo));
const result = {};
for (const [key, spec] of Object.entries(MAPS)) result[key] = buildMap(rings, spec);

process.stdout.write(
  '// Generated by tools/build-map.mjs. Map data: Natural Earth (public domain).\n'
  + `window.MAP_DATA = ${JSON.stringify(result)};\n`,
);
