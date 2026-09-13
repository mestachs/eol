// ============================================================================
// Éoliennes Aux Quatre Vents — simulateur 3D
// Coordinate convention (world/Three.js, Y-up):
//   worldX = east (m), worldZ = south (m)  =>  north direction = (0,0,-1)
//   worldY = real elevation (m a.s.l.), never exaggerated for math — only the
//            rendered terrain mesh geometry is scaled by the "exaggeration" UI.
// yaw: compass bearing in radians, 0 = north, 90° = east (matches azimuth).
// pitch: radians, positive = looking up.
// ============================================================================

const EARTH_EFFECTIVE_RADIUS = 8495000; // accounts for standard atmospheric refraction (k=0.87)
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------------------
// Terrain grid access
// ---------------------------------------------------------------------------
const G = window.TERRAIN_GRID;

function elevationAt(x, z) {
  // x = east, z = south -> north = -z
  const north = -z;
  const east = x;
  let colF = (east + G.half) / G.step;
  let rowF = (north + G.half) / G.step;
  colF = Math.min(Math.max(colF, 0), G.n - 1.0001);
  rowF = Math.min(Math.max(rowF, 0), G.n - 1.0001);
  const c0 = Math.floor(colF), r0 = Math.floor(rowF);
  const c1 = c0 + 1, r1 = r0 + 1;
  const fx = colF - c0, fy = rowF - r0;
  const e = G.elevations, n = G.n;
  const h00 = e[r0 * n + c0], h10 = e[r0 * n + c1];
  const h01 = e[r1 * n + c0], h11 = e[r1 * n + c1];
  const h0 = h00 * (1 - fx) + h10 * fx;
  const h1 = h01 * (1 - fx) + h11 * fx;
  return h0 * (1 - fy) + h1 * fy;
}

let ELEV_MIN = Infinity, ELEV_MAX = -Infinity;
for (const v of G.elevations) { if (v < ELEV_MIN) ELEV_MIN = v; if (v > ELEV_MAX) ELEV_MAX = v; }

// The "relief exaggeration" slider only ever scales the TERRAIN MESH's vertex
// heights (see buildTerrain) — every other object (camera, turbines, houses,
// buildings...) was still placed at the REAL elevation, so as soon as
// exaggeration != 1 the exaggerated ground rose above them and they ended up
// looking buried. displayElevationAt() is the exaggerated equivalent of
// elevationAt(), used ONLY for where things are drawn; every distance/angle/
// horizon calculation still uses the real elevationAt() so the physics stay
// correct regardless of the visual exaggeration.
let currentExaggeration = 1;
function displayElevationAt(x, z) {
  return ELEV_MIN + (elevationAt(x, z) - ELEV_MIN) * currentExaggeration;
}

// ---------------------------------------------------------------------------
// Site data (turbines, villages, default viewpoint)
// ---------------------------------------------------------------------------
const SITE = window.SITE_DATA;
const TURBINE_IDS = Object.keys(SITE.turbines).sort();

function toWorld(pt) { return { x: pt.x, z: -pt.y }; } // pt.y = north(m) from data files

// generic lat/lon <-> local-world (x=east, z=south) conversion, relative to the
// same grid origin used by terrain_data.js / site_data.js — needed for the OSM map.
function latlonToWorld(lat, lon) {
  const x = (lon - G.lon0) * 111320 * Math.cos(G.lat0 * Math.PI / 180);
  const north = (lat - G.lat0) * 110946;
  return { x, z: -north };
}
function worldToLatlon(x, z) {
  const north = -z;
  const lat = G.lat0 + north / 110946;
  const lon = G.lon0 + x / (111320 * Math.cos(G.lat0 * Math.PI / 180));
  return [lat, lon];
}

// ---------------------------------------------------------------------------
// Sun position (NOAA solar-position formulas) — date + local Belgian time ->
// azimuth/elevation at the site. Self-contained, no library/API needed.
// ---------------------------------------------------------------------------
function lastSundayUTC(year, monthIndex0) { // last Sunday of that month, 00:00 UTC
  const d = new Date(Date.UTC(year, monthIndex0 + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}
function belgiumUtcOffsetHours(year, month1, day) { // EU DST rule (date-level granularity)
  const approx = Date.UTC(year, month1 - 1, day, 12); // midday avoids edge-of-day ambiguity
  const dstStart = lastSundayUTC(year, 2).getTime() + 1 * 3600000; // March, 01:00 UTC
  const dstEnd = lastSundayUTC(year, 9).getTime() + 1 * 3600000; // October, 01:00 UTC
  return (approx >= dstStart && approx < dstEnd) ? 2 : 1; // CEST : CET
}
function localBelgiumToUTC(year, month1, day, hour, minute) {
  const offset = belgiumUtcOffsetHours(year, month1, day);
  return new Date(Date.UTC(year, month1 - 1, day, hour, minute) - offset * 3600000);
}

// Returns { elevation, azimuth } in radians. azimuth follows our usual bearing
// convention: 0 = north, increasing clockwise (90 = east) — same as `yaw`.
function sunPosition(utcDate, latDeg, lonDeg) {
  const rad = Math.PI / 180;
  const start = Date.UTC(utcDate.getUTCFullYear(), 0, 0);
  const dayFraction = (utcDate.getTime() - start) / 86400000;
  const gamma = ((2 * Math.PI) / 365) * (dayFraction - 1 + (utcDate.getUTCHours() - 12) / 24);

  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma)); // minutes
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma); // radians

  const timeOffset = eqtime + 4 * lonDeg; // minutes
  const trueSolarMin = utcDate.getUTCHours() * 60 + utcDate.getUTCMinutes() + utcDate.getUTCSeconds() / 60 + timeOffset;
  const ha = (trueSolarMin / 4 - 180) * rad; // hour angle, radians

  const latR = latDeg * rad;
  const cosZenith = Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  const elevation = Math.PI / 2 - zenith;

  let cosAz = (Math.sin(decl) - Math.sin(latR) * Math.cos(zenith)) / (Math.cos(latR) * Math.sin(zenith) || 1e-9);
  cosAz = Math.min(1, Math.max(-1, cosAz));
  let azimuth = Math.acos(cosAz);
  if (ha > 0) azimuth = 2 * Math.PI - azimuth;

  return { elevation, azimuth };
}

let params = {
  totalHeight: 230,
  hubHeight: 149, // official spec of the actual studied model: D=162m rotor, H=230m tip -> hub=230-81
  get rotorRadius() { return Math.max(5, this.totalHeight - this.hubHeight); }
};

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const SKY_PALETTE = {
  day: { horizon: new THREE.Color(0xd7e8f2), zenith: new THREE.Color(0x2f6fb0) },
  sunset: { horizon: new THREE.Color(0xffa864), zenith: new THREE.Color(0x3d5083) },
  night: { horizon: new THREE.Color(0x0c1524), zenith: new THREE.Color(0x02040a) },
};
const SKY_HORIZON = SKY_PALETTE.day.horizon.clone();
const SKY_ZENITH = SKY_PALETTE.day.zenith.clone();

const scene = new THREE.Scene();
scene.background = SKY_HORIZON.clone(); // fallback if the dome ever fails to init
scene.fog = new THREE.Fog(SKY_HORIZON.getHex(), 3000, 11000);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.5, 20000);
camera.rotation.order = 'YXZ';

const hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a2a, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.15);
sun.position.set(-3000, 2600, 1800);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const SHADOW_HALF = 2500; // metres — centred on the turbine cluster (near world origin)
sun.shadow.camera.left = -SHADOW_HALF;
sun.shadow.camera.right = SHADOW_HALF;
sun.shadow.camera.top = SHADOW_HALF;
sun.shadow.camera.bottom = -SHADOW_HALF;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 12000;
sun.shadow.bias = -0.0012;
sun.shadow.camera.updateProjectionMatrix();
scene.add(sun);
scene.add(sun.target);

// ---------------------------------------------------------------------------
// Sky dome — gradient (horizon haze -> zenith blue) + soft sun glow, standard
// "fake atmosphere" shader technique. Recentred on the camera every frame so
// it always reads as an infinitely distant sky, however far you fly.
// ---------------------------------------------------------------------------
const skyGroup = new THREE.Group();
scene.add(skyGroup);
let skyMat; // hoisted so the sun-position control (further down) can update sunDir live
{
  const skyGeo = new THREE.SphereGeometry(9000, 32, 16);
  skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: SKY_ZENITH },
      bottomColor: { value: SKY_HORIZON },
      sunDir: { value: sun.position.clone().normalize() },
      sunColor: { value: new THREE.Color(0xfff3d6) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor, bottomColor, sunDir, sunColor;
      varying vec3 vDir;
      void main() {
        float h = max(vDir.y, 0.0);
        vec3 col = mix(bottomColor, topColor, pow(h, 0.55));
        float sunAmount = max(dot(vDir, normalize(sunDir)), 0.0);
        col += sunColor * pow(sunAmount, 380.0) * 1.4;   // sun disc
        col += sunColor * pow(sunAmount, 5.0) * 0.25;    // soft glow around it
        // this is a raw ShaderMaterial, so (unlike MeshStandardMaterial etc.) it
        // doesn't get Three's automatic linear->sRGB output encoding — without
        // this, darker tones (the zenith blue) render almost black on screen.
        gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.renderOrder = -1000;
  skyGroup.add(skyMesh);
}

// a light scattering of soft cloud puffs (camera-facing sprites, no geometry cost)
let cloudMat; // hoisted so the sun/time-of-day control (further down) can dim it at night
{
  const cCanvas = document.createElement('canvas');
  cCanvas.width = cCanvas.height = 128;
  const cctx = cCanvas.getContext('2d');
  const grad = cctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  cctx.fillStyle = grad;
  cctx.fillRect(0, 0, 128, 128);
  const cloudTex = new THREE.CanvasTexture(cCanvas);
  cloudMat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, depthWrite: false, fog: false });

  for (let i = 0; i < 26; i++) {
    const sprite = new THREE.Sprite(cloudMat);
    const az = Math.random() * Math.PI * 2;
    const dist = 3200 + Math.random() * 2600;
    const height = 700 + Math.random() * 900;
    sprite.position.set(Math.sin(az) * dist, height, -Math.cos(az) * dist);
    const s = 500 + Math.random() * 900;
    sprite.scale.set(s * (1 + Math.random() * 0.6), s * 0.55, 1);
    sprite.renderOrder = -999;
    skyGroup.add(sprite);
  }
}

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// Sun/time-of-day control — moves the light + sky palette to match a chosen
// date & local (Belgian) time, and drives real shadow casting (see
// renderer.shadowMap / sun.shadow.* above) so turbine shadows — including the
// spinning-blade "shadow flicker" — actually fall on the real terrain.
// ---------------------------------------------------------------------------
const SUN_DISTANCE = 5000;
let lastSunElevDeg = 45;

const _tmpColorA = new THREE.Color(), _tmpColorB = new THREE.Color();

function updateSun(dateStr, hourFloat) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  let hh = Math.floor(hourFloat);
  let mm = Math.round((hourFloat - hh) * 60);
  if (mm === 60) { mm = 0; hh += 1; }
  const utc = localBelgiumToUTC(y, mo, d, hh % 24, mm);
  const { elevation, azimuth } = sunPosition(utc, G.lat0, G.lon0);
  const elevDeg = elevation * (180 / Math.PI);
  lastSunElevDeg = elevDeg;

  const dir = new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    -Math.cos(azimuth) * Math.cos(elevation)
  );
  // never let the light sink fully below the horizon plane (keeps the shadow
  // camera / hemisphere lookup well-behaved during full night, still dark)
  const dirForLight = dir.clone();
  dirForLight.y = Math.max(dirForLight.y, -0.03);
  sun.position.copy(dirForLight).multiplyScalar(SUN_DISTANCE);

  // day -> sunset -> night blend, driven purely by elevation
  const tDay = THREE.MathUtils.clamp(elevDeg / 14, 0, 1);       // 1 above ~14°, 0 at/under horizon
  const tNight = THREE.MathUtils.clamp(-(elevDeg + 2) / 6, 0, 1); // 0 above -2°, 1 by -8°
  _tmpColorA.copy(SKY_PALETTE.sunset.horizon).lerp(SKY_PALETTE.day.horizon, tDay);
  SKY_HORIZON.copy(SKY_PALETTE.night.horizon).lerp(_tmpColorA, 1 - tNight);
  _tmpColorB.copy(SKY_PALETTE.sunset.zenith).lerp(SKY_PALETTE.day.zenith, tDay);
  SKY_ZENITH.copy(SKY_PALETTE.night.zenith).lerp(_tmpColorB, 1 - tNight);
  scene.background.copy(SKY_HORIZON);
  scene.fog.color.copy(SKY_HORIZON);
  if (skyMat) skyMat.uniforms.sunDir.value.copy(dir);

  const notNight = 1 - tNight; // 1 = no night influence at all, 0 = full night (elevDeg <= -8°)
  const sunWarmth = 1 - tDay; // warmer/oranger low on the horizon
  sun.color.setRGB(1, 1 - sunWarmth * 0.35, 1 - sunWarmth * 0.65);
  sun.intensity = 0.05 + 1.45 * Math.max(tDay, notNight * 0.35);
  hemi.intensity = 0.06 + 0.94 * Math.max(tDay, notNight * 0.35); // much dimmer by midnight, not just "less day"

  // clouds: dim, desaturate towards a cool grey-blue, and fade a bit — a bright
  // white puff floating in a pitch-black sky reads as wrong at night.
  if (cloudMat) {
    const cloudLight = 0.18 + 0.82 * Math.max(tDay, notNight * 0.5);
    cloudMat.color.setRGB(cloudLight, cloudLight, Math.min(1, cloudLight * 1.08));
    cloudMat.opacity = 0.55 + 0.45 * Math.max(tDay, notNight);
  }

  updateSunReadout(elevDeg, azimuth * (180 / Math.PI));
}

function updateSunReadout(elevDeg, azDeg) {
  const el = document.getElementById('sunReadout');
  if (!el) return;
  const status = elevDeg <= -6 ? 'nuit' : elevDeg <= 0 ? 'crépuscule' : elevDeg < 10 ? 'soleil bas (ombres longues)' : 'jour';
  el.textContent = `Soleil : élévation ${elevDeg.toFixed(1)}°, azimut ${azDeg.toFixed(0)}° — ${status}`;
}

// ---------------------------------------------------------------------------
// Procedural farmland textures (ploughed soil, sugar beet rows, cereal, pasture)
// Generated once on a canvas — no external image assets needed (stays offline).
// ---------------------------------------------------------------------------
function hashNoise(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function makeFieldCanvas(size, painter) {
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = size;
  const ctx = cnv.getContext('2d');
  const img = ctx.createImageData(size, size);
  painter(img.data, size);
  ctx.putImageData(img, 0, 0);
  return cnv;
}

function toTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const CROP_TYPES = {
  ploughed: { patternMeters: 16, make: () => makeFieldCanvas(256, (d, size) => {
    const lines = 11;
    for (let y = 0; y < size; y++) {
      const phase = ((y % (size / lines)) / (size / lines));
      const ridge = 0.72 + 0.28 * Math.sin(phase * Math.PI * 2 - Math.PI / 2);
      for (let x = 0; x < size; x++) {
        const grain = 0.9 + 0.2 * hashNoise(x * 0.5, y * 0.5);
        const base = ridge * grain;
        const idx = (y * size + x) * 4;
        d[idx] = 92 * base + 20; d[idx + 1] = 62 * base + 12; d[idx + 2] = 38 * base + 8; d[idx + 3] = 255;
      }
    }
  })},
  beet: { patternMeters: 22, make: () => makeFieldCanvas(256, (d, size) => {
    const rows = 6, rowFrac = 0.55;
    for (let y = 0; y < size; y++) {
      const period = size / rows;
      const phase = (y % period) / period;
      const inRow = phase < rowFrac;
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        if (inRow) {
          const blob = 0.55 + 0.45 * Math.sin(x * 0.25 + Math.sin(y * 0.7) * 2) * Math.sin(x * 0.09 + y * 0.05);
          const g = Math.max(0.35, Math.min(1, blob + 0.15 * hashNoise(x, y)));
          d[idx] = 40 * g + 20; d[idx + 1] = 95 * g + 25; d[idx + 2] = 35 * g + 12; d[idx + 3] = 255;
        } else {
          const grain = 0.85 + 0.3 * hashNoise(x * 0.6, y * 0.6);
          d[idx] = 88 * grain + 24; d[idx + 1] = 60 * grain + 16; d[idx + 2] = 36 * grain + 10; d[idx + 3] = 255;
        }
      }
    }
  })},
  cereal: { patternMeters: 10, make: () => makeFieldCanvas(256, (d, size) => {
    for (let y = 0; y < size; y++) {
      const stripe = 0.9 + 0.1 * Math.sin(y * 1.4);
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const grain = 0.9 + 0.18 * hashNoise(x * 0.4, y * 0.4);
        const g = stripe * grain;
        d[idx] = 176 * g + 30; d[idx + 1] = 168 * g + 30; d[idx + 2] = 88 * g + 15; d[idx + 3] = 255;
      }
    }
  })},
  pasture: { patternMeters: 14, make: () => makeFieldCanvas(256, (d, size) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const mottle = 0.75 + 0.35 * hashNoise(x * 0.15, y * 0.15) - 0.15 * hashNoise(x * 0.7, y * 0.7);
        const g = Math.max(0.4, Math.min(1.1, mottle));
        d[idx] = 55 * g + 15; d[idx + 1] = 98 * g + 30; d[idx + 2] = 45 * g + 12; d[idx + 3] = 255;
      }
    }
  })},
};
const CROP_MATERIALS = {};
for (const [key, def] of Object.entries(CROP_TYPES)) {
  const tex = toTexture(def.make());
  CROP_MATERIALS[key] = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 1, metalness: 0 });
}
const CROP_KEYS = Object.keys(CROP_TYPES);
const CROP_WEIGHTS = { ploughed: 0.35, beet: 0.2, cereal: 0.3, pasture: 0.15 };
function pickCrop() {
  let r = Math.random(), acc = 0;
  for (const k of CROP_KEYS) { acc += CROP_WEIGHTS[k]; if (r <= acc) return k; }
  return CROP_KEYS[0];
}

// ---------------------------------------------------------------------------
// Terrain mesh — split into a patchwork of "field" blocks, each with its own
// crop texture, random furrow orientation and offset (realistic open-field look).
// ---------------------------------------------------------------------------
const terrainGroup = new THREE.Group();
scene.add(terrainGroup);

const FIELD_BLOCK = 12; // grid cells per field side (12*50m = 600m)
const numBlocks = (G.n - 1) / FIELD_BLOCK;
const fieldAssignments = [];
for (let bj = 0; bj < numBlocks; bj++) {
  for (let bi = 0; bi < numBlocks; bi++) {
    fieldAssignments.push({
      bi, bj,
      crop: pickCrop(),
      angle: Math.random() * Math.PI * 2,
      offsetU: Math.random(), offsetV: Math.random(),
    });
  }
}

let terrainMeshes = [];
function buildTerrain(exaggeration) {
  currentExaggeration = exaggeration;
  for (const m of terrainMeshes) { terrainGroup.remove(m); m.geometry.dispose(); }
  terrainMeshes = [];

  const n = G.n;
  // 1) full-grid positions + a global normal pass (avoids visible seams between fields)
  const fullPos = new Float32Array(n * n * 3);
  const tintFactor = new Float32Array(n * n); // subtle elevation-based brightness (AO-ish), not a color ramp
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const idx = row * n + col;
      const north = -G.half + row * G.step;
      const east = -G.half + col * G.step;
      const realElev = G.elevations[idx];
      const dispElev = ELEV_MIN + (realElev - ELEV_MIN) * exaggeration;
      fullPos[idx * 3 + 0] = east;
      fullPos[idx * 3 + 1] = dispElev;
      fullPos[idx * 3 + 2] = -north;
      const t = (realElev - ELEV_MIN) / Math.max(1, ELEV_MAX - ELEV_MIN);
      tintFactor[idx] = 0.82 + 0.28 * t;
    }
  }
  const fullIndices = [];
  for (let row = 0; row < n - 1; row++) {
    for (let col = 0; col < n - 1; col++) {
      const a = row * n + col, b = a + 1, c = a + n, d = c + 1;
      fullIndices.push(a, b, c, b, d, c);
    }
  }
  const tmpGeo = new THREE.BufferGeometry();
  tmpGeo.setAttribute('position', new THREE.BufferAttribute(fullPos, 3));
  tmpGeo.setIndex(fullIndices);
  tmpGeo.computeVertexNormals();
  const fullNormals = tmpGeo.getAttribute('normal').array;
  tmpGeo.dispose();

  // 2) one small mesh per field block, reusing the global positions/normals
  const B = FIELD_BLOCK;
  for (const field of fieldAssignments) {
    const c0 = field.bi * B, r0 = field.bj * B;
    const side = B + 1;
    const positions = new Float32Array(side * side * 3);
    const normals = new Float32Array(side * side * 3);
    const colors = new Float32Array(side * side * 3);
    const uvs = new Float32Array(side * side * 2);
    const uvSat = new Float32Array(side * side * 2); // global mapping, for the real-satellite-photo material
    const cosA = Math.cos(field.angle), sinA = Math.sin(field.angle);
    const pm = CROP_TYPES[field.crop].patternMeters;

    for (let j = 0; j <= B; j++) {
      for (let i = 0; i <= B; i++) {
        const col = c0 + i, row = r0 + j;
        const gIdx = row * n + col;
        const lIdx = j * side + i;
        positions[lIdx * 3 + 0] = fullPos[gIdx * 3 + 0];
        positions[lIdx * 3 + 1] = fullPos[gIdx * 3 + 1];
        positions[lIdx * 3 + 2] = fullPos[gIdx * 3 + 2];
        normals[lIdx * 3 + 0] = fullNormals[gIdx * 3 + 0];
        normals[lIdx * 3 + 1] = fullNormals[gIdx * 3 + 1];
        normals[lIdx * 3 + 2] = fullNormals[gIdx * 3 + 2];
        const tint = tintFactor[gIdx];
        colors[lIdx * 3 + 0] = tint; colors[lIdx * 3 + 1] = tint; colors[lIdx * 3 + 2] = tint;

        const localE = i * G.step, localN = j * G.step;
        const ru = localE * cosA - localN * sinA;
        const rv = localE * sinA + localN * cosA;
        uvs[lIdx * 2 + 0] = ru / pm + field.offsetU;
        uvs[lIdx * 2 + 1] = rv / pm + field.offsetV;

        // orthophoto.jpg was exported to cover exactly [-G.half,+G.half] in both
        // east and north (see scripts/fetch_orthophoto.py) -> direct linear mapping.
        const east = -G.half + col * G.step, north = -G.half + row * G.step;
        uvSat[lIdx * 2 + 0] = (east + G.half) / (2 * G.half);
        uvSat[lIdx * 2 + 1] = (north + G.half) / (2 * G.half);
      }
    }
    const indices = [];
    for (let j = 0; j < B; j++) {
      for (let i = 0; i < B; i++) {
        const a = j * side + i, b = a + 1, c = a + side, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    const mesh = new THREE.Mesh(geo, CROP_MATERIALS[field.crop]);
    mesh.userData.cropUv = uvs;
    mesh.userData.satUv = uvSat;
    mesh.userData.cropMaterial = CROP_MATERIALS[field.crop];
    mesh.receiveShadow = true; // catches turbine/building shadows (sun position control, below)
    terrainGroup.add(mesh);
    terrainMeshes.push(mesh);
  }
  return terrainMeshes;
}
buildTerrain(1); // real relief by default — no exaggeration

// Real aerial photo (SPW / Geoportail de Wallonie, ORTHO_LAST) draped over the
// same terrain meshes, as an alternative to the procedural crop patchwork —
// see scripts/fetch_orthophoto.py. Swaps each mesh's UV set + material; the
// geometry (positions/normals) stays exactly the same either way.
// Loaded via a plain Image (no crossOrigin attribute) rather than THREE.TextureLoader:
// TextureLoader sets crossOrigin='anonymous' by default, which makes Chromium refuse
// file:// image loads entirely ("origin 'null' ... only http/https/data/chrome"),
// breaking the double-click-to-open workflow. A bare <img>-style load has no such
// restriction for a same-folder local file, and works identically once served over http.
const satelliteTexture = new THREE.Texture();
satelliteTexture.colorSpace = THREE.SRGBColorSpace;
satelliteTexture.wrapS = satelliteTexture.wrapT = THREE.ClampToEdgeWrapping;
{
  const img = new Image();
  img.onload = () => { satelliteTexture.image = img; satelliteTexture.needsUpdate = true; };
  img.onerror = () => console.warn('orthophoto failed to load — satellite ground texture unavailable.');
  img.src = window.ORTHOPHOTO_DATA_URL;
}
const satelliteMaterial = new THREE.MeshStandardMaterial({ map: satelliteTexture, vertexColors: true, roughness: 1, metalness: 0 });

let groundTextureMode = 'crop'; // 'crop' | 'satellite'
function setGroundTextureMode(mode) {
  groundTextureMode = mode;
  for (const mesh of terrainMeshes) {
    if (mode === 'satellite') {
      mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.userData.satUv, 2));
      mesh.material = satelliteMaterial;
    } else {
      mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.userData.cropUv, 2));
      mesh.material = mesh.userData.cropMaterial;
    }
  }
}
setGroundTextureMode('satellite'); // default — matches the "Satellite (photo réelle)" radio checked in index.html

// a single invisible "picking" plane matching the whole grid footprint, used only
// for raycasting (house placement) so we don't have to hit-test 100 sub-meshes.
const pickGeo = new THREE.PlaneGeometry(G.half * 2, G.half * 2, 1, 1);
pickGeo.rotateX(-Math.PI / 2);
const pickMesh = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ visible: false }));
pickMesh.position.y = (ELEV_MIN + ELEV_MAX) / 2;
scene.add(pickMesh);

// ---------------------------------------------------------------------------
// Turbines
// ---------------------------------------------------------------------------
const turbineGroup = new THREE.Group();
scene.add(turbineGroup);
const turbineMeshes = {}; // id -> {group, rotor, base:{x,z,elev}}

// A tapered blade silhouette (wide-ish shoulder near the root, narrow tip) —
// a plain uniform-width box read as a flat plank, not a rotor blade.
function buildBladeGeometry(bladeLen) {
  const rootW = Math.max(0.45, bladeLen * 0.045);
  const shoulderW = rootW * 1.15;
  const tipW = Math.max(0.09, bladeLen * 0.009);
  const shoulderY = bladeLen * 0.16;
  const shape = new THREE.Shape();
  shape.moveTo(-rootW, 0);
  shape.lineTo(rootW, 0);
  shape.lineTo(shoulderW, shoulderY);
  shape.lineTo(tipW, bladeLen);
  shape.lineTo(-tipW, bladeLen);
  shape.lineTo(-shoulderW, shoulderY);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.4, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -0.2); // centre the thin thickness on the blade's own plane
  return geo;
}

function buildTurbines() {
  turbineGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  turbineGroup.clear();
  for (const id of TURBINE_IDS) {
    const w = toWorld(SITE.turbines[id]);
    const groundElev = elevationAt(w.x, w.z); // real elevation, used for the distance/angle/horizon maths
    const g = new THREE.Group();
    g.position.set(w.x, displayElevationAt(w.x, w.z), w.z); // exaggeration-aware render position

    const towerHeight = params.hubHeight;
    // realistic tower proportions for a ~230 m-class machine: base ~4.4 m
    // diameter tapering to ~2.7 m just under the nacelle.
    const towerGeo = new THREE.CylinderGeometry(1.35, 2.2, towerHeight, 16);
    const towerMat = new THREE.MeshStandardMaterial({ color: 0xf2f5f2, roughness: 0.6 });
    const tower = new THREE.Mesh(towerGeo, towerMat);
    tower.position.y = towerHeight / 2;
    tower.castShadow = true;
    g.add(tower);

    const nacelleGeo = new THREE.BoxGeometry(3, 3, 7);
    const nacelle = new THREE.Mesh(nacelleGeo, towerMat);
    nacelle.position.y = towerHeight;
    nacelle.castShadow = true;
    g.add(nacelle);

    const rotor = new THREE.Group();
    rotor.position.set(0, towerHeight, 4);
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    for (let b = 0; b < 3; b++) {
      // length = rotorRadius (hub to tip), not the full rotor diameter — a blade
      // is one radius long, and the earlier "*2" made blades ~twice too long,
      // reaching back down past the hub on the two downward-pointing blades.
      const bladeLen = params.rotorRadius * 0.94;
      const bladeGeo = buildBladeGeometry(bladeLen);
      const blade = new THREE.Mesh(bladeGeo, bladeMat);
      blade.rotation.z = (b * Math.PI * 2) / 3;
      blade.castShadow = true; // the moving blade shadows are the whole point of "shadow flicker"
      rotor.add(blade);
    }
    g.add(rotor);

    // slim ground disc marker (helps spot the base even if far/small)
    const discGeo = new THREE.CircleGeometry(6, 20);
    const discMat = new THREE.MeshBasicMaterial({ color: 0xff5555, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = 0.15;
    g.add(disc);

    // aviation obstruction light (red, blinking) — real turbines this tall carry one
    // on top of the nacelle, required for air-traffic visibility day and night.
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff1a1a });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.3, 10, 10), beaconMat);
    beacon.position.set(0, towerHeight + 3.2, 0);
    g.add(beacon);
    const beaconGlow = new THREE.PointLight(0xff2020, 0, 120); // intensity toggled with the blink
    beaconGlow.position.copy(beacon.position);
    g.add(beaconGlow);

    turbineGroup.add(g);
    turbineMeshes[id] = { group: g, rotor, beacon, beaconGlow, base: { x: w.x, z: w.z, elev: groundElev } };
  }
}
buildTurbines();

// ---------------------------------------------------------------------------
// Eiffel Tower reference marker (324 m per sizes.jpg) — a well-known scale
// reference next to the turbines, purely schematic (stacked tapered segments),
// not a detailed model. Placed just north of the turbine cluster.
// ---------------------------------------------------------------------------
const EIFFEL_HEIGHT = 324; // per sizes.jpg
const EIFFEL_WORLD = { x: 0, z: -1000 }; // z=south, so -1000 = 1000m north of grid origin
let eiffelGroup;
function buildEiffelTower() {
  const groundElev = displayElevationAt(EIFFEL_WORLD.x, EIFFEL_WORLD.z);
  const g = new THREE.Group();
  g.position.set(EIFFEL_WORLD.x, groundElev, EIFFEL_WORLD.z);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a332a, roughness: 0.7 });
  // [heightFraction, radiusBottom, radiusTop] stacked segments approximating the silhouette
  const segments = [
    [0.17, 50, 20], [0.35, 20, 11], [0.83, 11, 3], [1.0, 3, 0.6],
  ];
  let yBase = 0, hPrev = 0;
  for (const [hFrac, rBot, rTop] of segments) {
    const hTop = hFrac * EIFFEL_HEIGHT;
    const segH = hTop - hPrev;
    const geo = new THREE.CylinderGeometry(rTop, rBot, segH, 4); // 4 sides -> lattice-tower silhouette
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.y = Math.PI / 4;
    mesh.position.y = hPrev + segH / 2;
    g.add(mesh);
    hPrev = hTop;
  }
  eiffelGroup = g;
  scene.add(g);
}
buildEiffelTower();
eiffelGroup.visible = document.getElementById('chkEiffel').checked; // group defaults to visible=true otherwise

// ---------------------------------------------------------------------------
// Human-scale reference (~1.75 m), standing right beside E1 — the most direct,
// intuitive "how big is this really" comparison: a person right at the base.
// Stylised (capsules + a sphere head), not a detailed model.
// ---------------------------------------------------------------------------
const HUMAN_HEIGHT = 1.75;
const HUMAN_SKIN_MAT = new THREE.MeshStandardMaterial({ color: 0xe0b088, roughness: 0.85 });
const HUMAN_SHIRT_MAT = new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.85 });
const HUMAN_PANTS_MAT = new THREE.MeshStandardMaterial({ color: 0x33363d, roughness: 0.85 });
function buildOneHumanFigure() {
  const g = new THREE.Group();
  const legH = HUMAN_HEIGHT * 0.46;
  const torsoH = HUMAN_HEIGHT * 0.34;
  const headR = HUMAN_HEIGHT * 0.065;

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, legH, 8), HUMAN_PANTS_MAT);
    leg.position.set(side * 0.11, legH / 2, 0);
    leg.castShadow = true;
    g.add(leg);
  }
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, torsoH * 0.65, 4, 8), HUMAN_SHIRT_MAT);
  torso.position.set(0, legH + torsoH / 2, 0);
  torso.castShadow = true;
  g.add(torso);
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, torsoH * 0.8, 4, 6), HUMAN_SHIRT_MAT);
    arm.position.set(side * 0.26, legH + torsoH * 0.58, 0);
    arm.castShadow = true;
    g.add(arm);
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 12, 10), HUMAN_SKIN_MAT);
  head.position.set(0, legH + torsoH + headR, 0);
  head.castShadow = true;
  g.add(head);
  return g;
}

// one figure standing beside every turbine — the point is to see the scale
// contrast wherever you're looking, not just at a single designated one.
let humanGroup, humanWorld; // humanWorld/first instance still used by the floating label below
const humanInstances = []; // [{group, x, z}] — for repositioning on exaggeration change
function buildHumanFigures() {
  humanGroup = new THREE.Group();
  for (const id of TURBINE_IDS) {
    const t = turbineMeshes[id].base;
    const x = t.x + 12, z = t.z; // a few metres clear of the tower/ground-disc marker
    if (id === TURBINE_IDS[0]) humanWorld = { x, z };
    const g = buildOneHumanFigure();
    g.position.set(x, displayElevationAt(x, z), z);
    humanGroup.add(g);
    humanInstances.push({ group: g, x, z });
  }
  scene.add(humanGroup);
}
buildHumanFigures();
humanGroup.visible = document.getElementById('chkHuman').checked;

// ---------------------------------------------------------------------------
// Car reference (~4.3 m long, ~1.5 m tall) beside every turbine too, next to
// the human figure — a second, very familiar object for scale comparison.
// ---------------------------------------------------------------------------
const CAR_LENGTH = 4.3, CAR_WIDTH = 1.8, CAR_HEIGHT = 1.45;
const CAR_BODY_MAT = new THREE.MeshStandardMaterial({ color: 0xb5231a, roughness: 0.4, metalness: 0.3 });
const CAR_GLASS_MAT = new THREE.MeshStandardMaterial({ color: 0x22282e, roughness: 0.3, metalness: 0.1 });
const CAR_WHEEL_MAT = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 });
function buildOneCar() {
  const g = new THREE.Group();
  const wheelR = 0.33, clearance = 0.15;
  const bodyH = 0.85;

  const body = new THREE.Mesh(new THREE.BoxGeometry(CAR_WIDTH, bodyH, CAR_LENGTH), CAR_BODY_MAT);
  body.position.y = clearance + wheelR - 0.1 + bodyH / 2;
  body.castShadow = true;
  g.add(body);

  const cabinH = CAR_HEIGHT - body.position.y - bodyH / 2;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(CAR_WIDTH * 0.86, cabinH, CAR_LENGTH * 0.52), CAR_GLASS_MAT);
  cabin.position.set(0, body.position.y + bodyH / 2 + cabinH / 2, -CAR_LENGTH * 0.04);
  cabin.castShadow = true;
  g.add(cabin);

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(wheelR, wheelR, 0.24, 14), CAR_WHEEL_MAT);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(sx * (CAR_WIDTH / 2 - 0.02), wheelR, sz * (CAR_LENGTH / 2 - 0.75));
      wheel.castShadow = true;
      g.add(wheel);
    }
  }
  return g;
}
let carGroup, carWorld;
const carInstances = [];
function buildCars() {
  carGroup = new THREE.Group();
  for (const id of TURBINE_IDS) {
    const t = turbineMeshes[id].base;
    const x = t.x + 12, z = t.z + 3; // right beside the human figure at the same spot
    if (id === TURBINE_IDS[0]) carWorld = { x, z };
    const g = buildOneCar();
    g.position.set(x, displayElevationAt(x, z), z);
    g.rotation.y = Math.PI / 2; // broadside-on, reads better as "a car" from most angles than nose-on
    carGroup.add(g);
    carInstances.push({ group: g, x, z });
  }
  scene.add(carGroup);
}
buildCars();
carGroup.visible = document.getElementById('chkCar').checked;

// ---------------------------------------------------------------------------
// Village / reference markers (small posts + labels handled via minimap mostly)
// ---------------------------------------------------------------------------
const villageGroup = new THREE.Group();
scene.add(villageGroup);
const villageMarkerMat = new THREE.MeshStandardMaterial({ color: 0x3a6ea5 });
function buildVillageMarkers() {
  for (const m of villageGroup.children) m.geometry.dispose(); // material is shared, not disposed here
  villageGroup.clear();
  for (const [name, pt] of Object.entries(SITE.villages)) {
    const w = toWorld(pt);
    if (Math.abs(w.x) > G.half || Math.abs(w.z) > G.half) continue;
    const elev = displayElevationAt(w.x, w.z);
    const geo = new THREE.ConeGeometry(4, 14, 6);
    const m = new THREE.Mesh(geo, villageMarkerMat);
    m.position.set(w.x, elev + 7, w.z);
    villageGroup.add(m);
  }
}
buildVillageMarkers();

// ---------------------------------------------------------------------------
// 3D buildings — real footprints (SPW / Geoportail de Wallonie, PICC), extruded
// to a stylised height per building-type code (footprints have no height data).
// All ~8000 footprints are merged into a single BufferGeometry (one draw call).
// ---------------------------------------------------------------------------
// Merges many per-building ExtrudeGeometry instances (position/normal/uv/color,
// all non-indexed) into one shared set of attributes, plus TWO index buffers —
// one for each of ExtrudeGeometry's built-in material groups (verified empirically:
// group materialIndex 0 = caps i.e. roof+floor, materialIndex 1 = extruded sides
// i.e. walls) — so walls and roofs can get different materials/textures while
// still sharing the same underlying vertex data (no duplication).
function mergeBuildingGeometries(geoms) {
  let totalV = 0;
  const capCounts = [], sideCounts = [];
  for (const g of geoms) {
    totalV += g.attributes.position.count;
    const capGroup = g.groups.find((gr) => gr.materialIndex === 0);
    const sideGroup = g.groups.find((gr) => gr.materialIndex === 1);
    capCounts.push(capGroup ? capGroup.count : 0);
    sideCounts.push(sideGroup ? sideGroup.count : 0);
  }
  const totalCap = capCounts.reduce((a, b) => a + b, 0);
  const totalSide = sideCounts.reduce((a, b) => a + b, 0);

  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const colors = new Float32Array(totalV * 3);
  const capIndices = new Uint32Array(totalCap);
  const sideIndices = new Uint32Array(totalSide);

  let vBase = 0, capOff = 0, sideOff = 0;
  for (let gi = 0; gi < geoms.length; gi++) {
    const g = geoms[gi];
    const pos = g.attributes.position.array;
    const norm = g.attributes.normal.array;
    const uv = g.attributes.uv.array;
    const col = g.attributes.color ? g.attributes.color.array : null;
    const vCount = pos.length / 3;
    positions.set(pos, vBase * 3);
    normals.set(norm, vBase * 3);
    uvs.set(uv, vBase * 2);
    if (col) colors.set(col, vBase * 3); else colors.fill(1, vBase * 3, (vBase + vCount) * 3);

    const capGroup = g.groups.find((gr) => gr.materialIndex === 0);
    const sideGroup = g.groups.find((gr) => gr.materialIndex === 1);
    if (capGroup) {
      for (let i = 0; i < capGroup.count; i++) capIndices[capOff + i] = vBase + capGroup.start + i;
      capOff += capGroup.count;
    }
    if (sideGroup) {
      for (let i = 0; i < sideGroup.count; i++) sideIndices[sideOff + i] = vBase + sideGroup.start + i;
      sideOff += sideGroup.count;
    }
    vBase += vCount;
  }

  const posAttr = new THREE.BufferAttribute(positions, 3);
  const normAttr = new THREE.BufferAttribute(normals, 3);
  const uvAttr = new THREE.BufferAttribute(uvs, 2);
  const colorAttr = new THREE.BufferAttribute(colors, 3);

  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', posAttr);
  roofGeo.setAttribute('normal', normAttr);
  roofGeo.setAttribute('uv', uvAttr);
  roofGeo.setAttribute('color', colorAttr);
  roofGeo.setIndex(new THREE.BufferAttribute(capIndices, 1));

  const wallGeo = new THREE.BufferGeometry();
  wallGeo.setAttribute('position', posAttr);
  wallGeo.setAttribute('normal', normAttr);
  wallGeo.setAttribute('uv', uvAttr);
  wallGeo.setAttribute('color', colorAttr);
  wallGeo.setIndex(new THREE.BufferAttribute(sideIndices, 1));

  return { roofGeo, wallGeo };
}

// Procedural facade (brick coursing) and roof (tile rows) textures — same
// grayscale-multiply trick as the farmland textures: the texture supplies fine
// detail (mortar lines, tile shading) while each building's own vertex color
// (random per-building brick/render/roof tone) supplies the actual hue.
const BUILDING_WALL_TEX = toTexture(makeFieldCanvas(128, (d, size) => {
  const courseH = 10, brickW = 24;
  for (let y = 0; y < size; y++) {
    const row = Math.floor(y / courseH);
    const mortarY = y % courseH < 1.5;
    const offset = (row % 2) * (brickW / 2);
    for (let x = 0; x < size; x++) {
      const mortarX = ((x + offset) % brickW) < 1.5;
      const g = (mortarY || mortarX) ? 0.72 : 0.94 + 0.05 * hashNoise(x * 0.7, y * 0.7);
      const idx = (y * size + x) * 4;
      d[idx] = d[idx + 1] = d[idx + 2] = Math.min(255, g * 235);
      d[idx + 3] = 255;
    }
  }
}));
BUILDING_WALL_TEX.repeat.set(0.35, 0.35);
const BUILDING_ROOF_TEX = toTexture(makeFieldCanvas(128, (d, size) => {
  const rowH = 12;
  for (let y = 0; y < size; y++) {
    const phase = (y % rowH) / rowH;
    const shade = 0.78 + 0.22 * Math.sin(phase * Math.PI); // rounded tile overlap highlight
    for (let x = 0; x < size; x++) {
      const g = shade * (0.95 + 0.08 * hashNoise(x * 0.5, y * 0.9));
      const idx = (y * size + x) * 4;
      d[idx] = d[idx + 1] = d[idx + 2] = Math.min(255, g * 235);
      d[idx + 3] = 255;
    }
  }
}));
BUILDING_ROOF_TEX.repeat.set(0.6, 0.6);

const WALL_TONES = [0xe4dcc8, 0xc9a687, 0xd9c9a8, 0xb7bcc0, 0xecdccb]; // whitewash, brick, sand, grey render, cream
const ROOF_TONES = [0x8a4a3a, 0x5c5f66, 0x7a5a4a, 0x9c5c3f]; // terracotta, slate, brown tile, red tile

// Small footprints (garden sheds / "cabanes de jardin", carports…) are wood,
// not masonry — a plank-siding texture + a plain dark felt/corrugated roof.
const SHED_MAX_AREA_M2 = 20;
function polygonAreaM2(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}
const BUILDING_SHED_WALL_TEX = toTexture(makeFieldCanvas(128, (d, size) => {
  const plankH = 14;
  for (let y = 0; y < size; y++) {
    const edge = (y % plankH) < 1.5; // horizontal lap-siding seam
    const grain = 0.85 + 0.15 * Math.sin(y * 0.9);
    for (let x = 0; x < size; x++) {
      const g = (edge ? 0.62 : grain) * (0.92 + 0.1 * hashNoise(x * 0.8, y * 1.1));
      const idx = (y * size + x) * 4;
      d[idx] = Math.min(255, g * 168); d[idx + 1] = Math.min(255, g * 118); d[idx + 2] = Math.min(255, g * 72);
      d[idx + 3] = 255;
    }
  }
}));
BUILDING_SHED_WALL_TEX.repeat.set(0.5, 0.5);
const BUILDING_SHED_ROOF_TEX = toTexture(makeFieldCanvas(64, (d, size) => {
  for (let y = 0; y < size; y++) {
    const ridge = 0.85 + 0.15 * Math.sin(y * 1.1);
    for (let x = 0; x < size; x++) {
      const g = ridge * (0.9 + 0.15 * hashNoise(x * 0.6, y * 0.6));
      const idx = (y * size + x) * 4;
      d[idx] = d[idx + 1] = d[idx + 2] = Math.min(255, g * 130);
      d[idx + 3] = 255;
    }
  }
}));
BUILDING_SHED_ROOF_TEX.repeat.set(0.4, 0.4);

// Pitched (gable) roof for "real" houses — flat building-footprint extrusions
// look too much like industrial sheds otherwise. Approximated as a simple
// ridge-and-two-slopes prism sized to the footprint's oriented bounding box
// (ridge aligned with the footprint's longest edge, which for most real house
// footprints is a good proxy for the actual roof ridge direction), rather than
// an exact per-polygon roof — good enough for a stylised, believable skyline,
// and robust for the ~6000 irregular real footprints this runs over.
function buildGableRoofGeometry(points, eaveHeight, roofColor) {
  let maxLen = -1, angle = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len > maxLen) { maxLen = len; angle = Math.atan2(y2 - y1, x2 - x1); }
  }
  const ca = Math.cos(-angle), sa = Math.sin(-angle);
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const [x, y] of points) {
    const a = x * ca - y * sa, b = x * sa + y * ca;
    if (a < minA) minA = a; if (a > maxA) maxA = a;
    if (b < minB) minB = b; if (b > maxB) maxB = b;
  }
  const overhang = 0.35;
  minA -= overhang; maxA += overhang; minB -= overhang; maxB += overhang;
  const midB = (minB + maxB) / 2;
  const halfSpan = (maxB - minB) / 2;
  const rise = Math.min(3.2, Math.max(0.8, halfSpan * 0.65)); // moderate pitch, capped for very wide/odd footprints
  const ridgeH = eaveHeight + rise;

  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const P = (a, b, h) => [a * cosA - b * sinA, a * sinA + b * cosA, h]; // back to world (x,y), h stays as extrude-depth axis
  const e1 = P(minA, minB, eaveHeight), e2 = P(maxA, minB, eaveHeight);
  const e3 = P(maxA, maxB, eaveHeight), e4 = P(minA, maxB, eaveHeight);
  const r1 = P(minA, midB, ridgeH), r2 = P(maxA, midB, ridgeH);

  const tris = [
    e1, e2, r2, e1, r2, r1,       // slope 1 (minB side)
    e4, r1, r2, e4, r2, e3,       // slope 2 (maxB side)
    e1, r1, e4,                    // gable end at minA
    e2, e3, r2,                    // gable end at maxA
  ];
  const positions = new Float32Array(tris.length * 3);
  const uvs = new Float32Array(tris.length * 2);
  const colors = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    positions.set(tris[i], i * 3);
    uvs[i * 2] = tris[i][0] / 6; uvs[i * 2 + 1] = tris[i][1] / 6;
    roofColor.toArray(colors, i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals(); // non-indexed -> naturally faceted/flat-shaded per triangle
  return geo;
}

// Concatenates several non-indexed position/normal/uv/color geometries into one
// (simpler than mergeBuildingGeometries: no material-group splitting needed).
function concatGeometriesSimple(geoms) {
  let totalV = 0;
  for (const g of geoms) totalV += g.attributes.position.count;
  const positions = new Float32Array(totalV * 3), normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2), colors = new Float32Array(totalV * 3);
  let v = 0;
  for (const g of geoms) {
    const n = g.attributes.position.count;
    positions.set(g.attributes.position.array, v * 3);
    normals.set(g.attributes.normal.array, v * 3);
    uvs.set(g.attributes.uv.array, v * 2);
    colors.set(g.attributes.color.array, v * 3);
    v += n;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return merged;
}

const buildingsGroup = new THREE.Group();
scene.add(buildingsGroup);
function buildBuildings() {
  for (const m of buildingsGroup.children) { m.geometry.dispose(); m.material.dispose(); }
  buildingsGroup.clear();
  const footprints = window.BUILDINGS_DATA || [];
  const perBuildingMasonry = [], perBuildingShed = [], perBuildingGableRoofs = [];
  const wallColor = new THREE.Color(), roofColor = new THREE.Color();
  let shedCount = 0;
  for (const b of footprints) {
    if (b.p.length < 3) continue;
    const isShed = polygonAreaM2(b.p) < SHED_MAX_AREA_M2;
    if (isShed) shedCount++;

    const shape = new THREE.Shape(b.p.map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: b.h, bevelEnabled: false, curveSegments: 1 });
    geo.rotateX(-Math.PI / 2); // (x, northY, height) -> world (east, up, south)
    let cx = 0, cy = 0;
    for (const [x, y] of b.p) { cx += x; cy += y; }
    cx /= b.p.length; cy /= b.p.length;
    const groundElev = displayElevationAt(cx, -cy);
    geo.translate(0, groundElev, 0);

    // one random-but-fixed wall tone + roof tone per building, for variety
    // (real villages mix whitewash/brick/render walls and tile/slate roofs;
    // small sheds/carports get a plain wood/dark-roof tint instead)
    if (isShed) {
      wallColor.set(0xffffff); // texture already carries the wood colour
      roofColor.set(0xffffff);
    } else {
      wallColor.set(WALL_TONES[Math.floor(hashNoise(cx, cy) * WALL_TONES.length) % WALL_TONES.length]);
      roofColor.set(ROOF_TONES[Math.floor(hashNoise(cy, cx) * ROOF_TONES.length) % ROOF_TONES.length]);
    }
    const vCount = geo.attributes.position.count;
    const colors = new Float32Array(vCount * 3);
    const capGroup = geo.groups.find((gr) => gr.materialIndex === 0);
    const sideGroup = geo.groups.find((gr) => gr.materialIndex === 1);
    for (let i = 0; i < vCount; i++) colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 1; // default white
    if (capGroup) for (let i = 0; i < capGroup.count; i++) roofColor.toArray(colors, (capGroup.start + i) * 3);
    if (sideGroup) for (let i = 0; i < sideGroup.count; i++) wallColor.toArray(colors, (sideGroup.start + i) * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    if (!isShed) {
      // real house-shaped roof instead of the flat cap above (see buildGableRoofGeometry)
      const roofGeo = buildGableRoofGeometry(b.p, b.h, roofColor);
      roofGeo.rotateX(-Math.PI / 2);
      roofGeo.translate(0, groundElev, 0);
      perBuildingGableRoofs.push(roofGeo);
    }
    (isShed ? perBuildingShed : perBuildingMasonry).push(geo);
  }

  function addMesh(geo, tex, doubleSide) {
    const mat = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, roughness: 1 });
    if (doubleSide) mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    buildingsGroup.add(mesh);
  }

  // masonry: walls from the extrusion's side faces, roof from the gable prisms
  // built above. The extrusion's own flat cap is kept too — as a hidden "attic
  // ceiling" right under the gable roof — so that any hairline gap between the
  // (independently-computed) gable roof and the actual wall footprint shows
  // this ceiling instead of a stray see-through sliver of sky.
  if (perBuildingMasonry.length) {
    const { roofGeo: flatCapAsCeiling, wallGeo } = mergeBuildingGeometries(perBuildingMasonry);
    for (const g of perBuildingMasonry) g.dispose();
    addMesh(wallGeo, BUILDING_WALL_TEX);
    // plain black, unlit — this is the underside of the attic/roof, never meant
    // to be a lit, textured surface; it only exists to back up any hairline
    // gap between the gable roof and the wall top with something dark instead
    // of a stray sliver of sky.
    const ceilingMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    buildingsGroup.add(new THREE.Mesh(flatCapAsCeiling, ceilingMat));
  }
  if (perBuildingGableRoofs.length) {
    const gableGeo = concatGeometriesSimple(perBuildingGableRoofs);
    for (const g of perBuildingGableRoofs) g.dispose();
    addMesh(gableGeo, BUILDING_ROOF_TEX);
  }

  // sheds: unchanged flat-cap roof + wood walls
  if (perBuildingShed.length) {
    const { roofGeo, wallGeo } = mergeBuildingGeometries(perBuildingShed);
    for (const g of perBuildingShed) g.dispose();
    addMesh(roofGeo, BUILDING_SHED_ROOF_TEX);
    addMesh(wallGeo, BUILDING_SHED_WALL_TEX);
  }

  const countEl = document.getElementById('buildingsCount');
  if (countEl) countEl.textContent = footprints.length.toLocaleString('fr-BE') + ` (dont ~${shedCount.toLocaleString('fr-BE')} petites annexes/cabanes en bois)`;
}
buildBuildings();

// ---------------------------------------------------------------------------
// Vegetation — real OSM trees/tree-rows/hedges/woods, rendered as instanced
// simple trees (cone canopy + cylinder trunk). Heights are stylised (OSM has
// none): isolated trees/rows ~2-4m, hedges ~1.2-2m (squat, sparse trunk),
// woods/forests ~7-14m. One InstancedMesh each for trunks and canopies keeps
// this to 2 draw calls regardless of count (typically several thousand).
// ---------------------------------------------------------------------------
const vegetationGroup = new THREE.Group();
scene.add(vegetationGroup);
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function interpolateLine(pts, spacing) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const segLen = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.round(segLen / spacing));
    for (let s = 0; s < steps; s++) { const t = s / steps; out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]); }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function samplePolygon(poly, areaPerTree) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, shoelace = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x, y] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    shoelace += x * y2 - x2 * y;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const area = Math.abs(shoelace) / 2;
  const target = Math.max(1, Math.round(area / areaPerTree));
  const pts = [];
  let attempts = 0;
  while (pts.length < target && attempts < target * 25) {
    attempts++;
    const x = minX + Math.random() * (maxX - minX), y = minY + Math.random() * (maxY - minY);
    if (pointInPolygon(x, y, poly)) pts.push([x, y]);
  }
  return pts;
}

const vegPlantings = []; // {x, y(north), cat} — fixed once, independent of exaggeration
{
  const veg = window.VEGETATION_DATA || { trees: [], treeRows: [], hedges: [], woods: [] };
  for (const [x, y] of veg.trees) vegPlantings.push({ x, y, cat: 'tree' });
  for (const row of veg.treeRows) for (const [x, y] of interpolateLine(row, 5)) vegPlantings.push({ x, y, cat: 'row' });
  for (const hedge of veg.hedges) for (const [x, y] of interpolateLine(hedge, 2.5)) vegPlantings.push({ x, y, cat: 'hedge' });
  for (const wood of veg.woods) for (const [x, y] of samplePolygon(wood, 120)) vegPlantings.push({ x, y, cat: 'wood' });
}
const vegTrunkGeo = new THREE.CylinderGeometry(1, 1, 1, 6); vegTrunkGeo.translate(0, 0.5, 0);
const vegCanopyGeo = new THREE.ConeGeometry(1, 1, 7); vegCanopyGeo.translate(0, 0.5, 0);
const vegTrunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 });
const vegCanopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }); // tinted per-instance below
const vegTrunkMesh = new THREE.InstancedMesh(vegTrunkGeo, vegTrunkMat, vegPlantings.length);
const vegCanopyMesh = new THREE.InstancedMesh(vegCanopyGeo, vegCanopyMat, vegPlantings.length);
vegTrunkMesh.castShadow = vegCanopyMesh.castShadow = true;
vegetationGroup.add(vegTrunkMesh, vegCanopyMesh);
{
  const el = document.getElementById('vegetationCount');
  if (el) el.textContent = vegPlantings.length.toLocaleString('fr-BE');
}

// (re)computes every instance's transform from its real position + the current
// exaggeration — cheap enough to redo whenever exaggeration changes (unlike
// buildBuildings(), no geometry is rebuilt, just per-instance matrices).
function layoutVegetation() {
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  for (let i = 0; i < vegPlantings.length; i++) {
    const p = vegPlantings[i];
    const worldZ = -p.y; // p.y = north -> world z = south
    const groundElev = displayElevationAt(p.x, worldZ);
    const n = hashNoise(p.x, p.y);
    let H, trunkFrac, canopyRadiusFrac, green;
    if (p.cat === 'hedge') { H = 1.2 + n * 0.8; trunkFrac = 0.12; canopyRadiusFrac = 0.65; green = 0.30 + n * 0.12; }
    else if (p.cat === 'wood') { H = 7 + n * 7; trunkFrac = 0.55; canopyRadiusFrac = 0.30; green = 0.24 + n * 0.14; }
    else { H = 2 + n * 2; trunkFrac = 0.4; canopyRadiusFrac = 0.4; green = 0.32 + n * 0.16; }
    const trunkH = H * trunkFrac, canopyH = H - trunkH, canopyR = H * canopyRadiusFrac;
    const trunkR = Math.max(0.07, trunkH * 0.07);

    dummy.position.set(p.x, groundElev, worldZ);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(trunkR, Math.max(0.15, trunkH), trunkR);
    dummy.updateMatrix();
    vegTrunkMesh.setMatrixAt(i, dummy.matrix);

    dummy.position.set(p.x, groundElev + trunkH, worldZ);
    dummy.scale.set(canopyR, canopyH, canopyR);
    dummy.updateMatrix();
    vegCanopyMesh.setMatrixAt(i, dummy.matrix);
    col.setRGB(0.16, green, 0.14 + green * 0.3);
    vegCanopyMesh.setColorAt(i, col);
  }
  vegTrunkMesh.instanceMatrix.needsUpdate = true;
  vegCanopyMesh.instanceMatrix.needsUpdate = true;
  if (vegCanopyMesh.instanceColor) vegCanopyMesh.instanceColor.needsUpdate = true;
}
layoutVegetation();

// ---------------------------------------------------------------------------
// House marker
// ---------------------------------------------------------------------------
const houseMesh = (() => {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(8, 6, 8), new THREE.MeshStandardMaterial({ color: 0xd8c39a }));
  body.position.y = 3;
  body.receiveShadow = true;
  g.add(body);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(6.5, 4, 4), new THREE.MeshStandardMaterial({ color: 0x7a3b2e }));
  roof.position.y = 8; roof.rotation.y = Math.PI / 4;
  roof.receiveShadow = true;
  g.add(roof);
  scene.add(g);
  return g;
})();

let house = null; // {x, z, groundElev, eyeHeight}
let osmMap = null, osmHouseMarker = null, osmCameraMarker = null; // set once the Leaflet map is initialised, further down

function setHouse(x, z, eyeHeight, panMap = true) {
  const groundElev = elevationAt(x, z); // real elevation, used for eye-height/denivelé maths
  house = { x, z, groundElev, eyeHeight: eyeHeight ?? (house ? house.eyeHeight : 1.6) };
  houseMesh.position.set(x, displayElevationAt(x, z), z); // exaggeration-aware render position
  houseMesh.visible = (mode !== 'eye'); // hidden while the camera sits at/inside it (see btnEye handler)
  if (osmHouseMarker) {
    const latlon = worldToLatlon(x, z);
    osmHouseMarker.setLatLng(latlon);
    if (panMap && osmMap) osmMap.panTo(latlon);
  }
  updateAll();
}

// initial house location: 17E rue du Surtia, Saint-Denis — positioned in the garden
// (~18 m beyond the OSM building centroid, on the side facing the turbines).
// The actual setHouse() call — which triggers table/canvas rendering — happens at
// the end of this file, once every UI element referenced by updateAll() exists.
const INITIAL_HOUSE_WORLD = toWorld(SITE.house17E);

// ---------------------------------------------------------------------------
// Camera control (free-fly and locked-eye modes)
// ---------------------------------------------------------------------------
let mode = 'eye'; // 'eye' | 'free'
let yaw = 0, pitch = 0; // radians
const keys = {};
let dragging = false, lastX = 0, lastY = 0;
let freeSpeed = 140; // m/s base — fast enough to cross the whole 6km grid in ~40s

// place camera somewhere sensible in free mode initially: above the house, looking at turbines
camera.position.set(INITIAL_HOUSE_WORLD.x, elevationAt(INITIAL_HOUSE_WORLD.x, INITIAL_HOUSE_WORLD.z) + 120, INITIAL_HOUSE_WORLD.z + 220);
const turbineCentroid = TURBINE_IDS.reduce((acc, id) => {
  const b = turbineMeshes[id].base; acc.x += b.x / TURBINE_IDS.length; acc.z += b.z / TURBINE_IDS.length; return acc;
}, { x: 0, z: 0 });
lookAtBearing(bearingTo(INITIAL_HOUSE_WORLD, turbineCentroid));

function bearingTo(fromPos, targetBase) {
  const dx = targetBase.x - fromPos.x;
  const dz = targetBase.z - fromPos.z; // south
  const north = -dz;
  return Math.atan2(dx, north); // 0 = north, 90deg = east
}

function lookAtBearing(b) { yaw = b; pitch = -0.12; }

function forwardVector(y = yaw, p = pitch) {
  return new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
}
function rightVector(y = yaw) {
  return new THREE.Vector3(Math.cos(y), 0, Math.sin(y));
}

function applyCameraRotation() {
  pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, pitch));
  camera.rotation.set(pitch, -yaw, 0);
}

canvas.addEventListener('mousedown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
addEventListener('mouseup', () => dragging = false);
addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  yaw += dx * 0.0035;
  pitch -= dy * 0.0035;
});

// touch/swipe equivalent — mouse events aren't reliably synthesized for a real
// drag gesture on every mobile browser, so this is handled explicitly rather
// than assumed. Single-finger only (a second finger is left alone, in case a
// pinch-style gesture gets added later); a plain tap (no/negligible movement)
// still falls through to the normal synthetic 'click' below, so tapping to
// place the house keeps working.
let lookTouchId = null;
canvas.addEventListener('touchstart', (e) => {
  if (dragging || e.touches.length !== 1) return;
  const t = e.touches[0];
  dragging = true; lookTouchId = t.identifier; lastX = t.clientX; lastY = t.clientY;
}, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  if (!dragging) return;
  const t = Array.from(e.touches).find((tt) => tt.identifier === lookTouchId);
  if (!t) return;
  const dx = t.clientX - lastX, dy = t.clientY - lastY;
  lastX = t.clientX; lastY = t.clientY;
  yaw += dx * 0.0035;
  pitch -= dy * 0.0035;
  e.preventDefault(); // now that it's an actual look-around drag, stop the page from also trying to scroll/zoom
}, { passive: false });
function endLookTouch(e) {
  if (lookTouchId !== null && (!e.touches || !Array.from(e.touches).some((t) => t.identifier === lookTouchId))) {
    dragging = false; lookTouchId = null;
  }
}
canvas.addEventListener('touchend', endLookTouch);
canvas.addEventListener('touchcancel', endLookTouch);
addEventListener('keydown', (e) => { keys[e.code] = true; });
addEventListener('keyup', (e) => { keys[e.code] = false; });
canvas.addEventListener('wheel', (e) => {
  freeSpeed = Math.max(5, Math.min(1500, freeSpeed * (e.deltaY > 0 ? 0.88 : 1.12)));
}, { passive: true });

// terrain click -> place house
let placingHouse = false;
const raycaster = new THREE.Raycaster();
canvas.addEventListener('click', (e) => {
  if (!placingHouse) return;
  const mouse = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const hit = raycaster.intersectObject(pickMesh, false)[0];
  if (hit) {
    setHouse(hit.point.x, hit.point.z, house ? house.eyeHeight : 1.6);
    placingHouse = false;
    document.getElementById('btnPlaceHouse').textContent = '📍 Cliquer sur le terrain pour placer la maison';
    document.getElementById('crosshair').classList.remove('show');
  }
});

let lastT = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  skyGroup.position.copy(camera.position); // sky/clouds always read as infinitely distant

  if (sunPlaying) {
    let t = parseFloat(sunTimeInput.value) + dt * 0.5; // half an hour of sim time per real second
    if (t >= 24) t -= 24;
    sunTimeInput.value = t;
    refreshSun();
  }

  if (osmCameraMarker) {
    const el = osmCameraMarker.getElement();
    if (mode === 'free') {
      const [lat, lon] = worldToLatlon(camera.position.x, camera.position.z);
      osmCameraMarker.setLatLng([lat, lon]);
      el.style.display = '';
      const arrow = el.querySelector('.cam-arrow');
      if (arrow) arrow.style.transform = `rotate(${yaw * DEG}deg)`;
    } else {
      el.style.display = 'none';
    }
  }

  applyCameraRotation();

  if (mode === 'free') {
    const boost = keys['ShiftLeft'] || keys['ShiftRight'] ? 3 : 1;
    const spd = freeSpeed * boost * dt;
    const f = forwardVector(), r = rightVector();
    if (keys['KeyW'] || keys['ArrowUp']) camera.position.addScaledVector(f, spd);
    if (keys['KeyS'] || keys['ArrowDown']) camera.position.addScaledVector(f, -spd);
    if (keys['KeyD'] || keys['ArrowRight']) camera.position.addScaledVector(r, spd);
    if (keys['KeyA'] || keys['ArrowLeft']) camera.position.addScaledVector(r, -spd);
    if (keys['KeyE']) camera.position.y += spd;
    if (keys['KeyQ']) camera.position.y -= spd;
    const minY = displayElevationAt(camera.position.x, camera.position.z) + 1.2;
    if (camera.position.y < minY) camera.position.y = minY;
  } else if (mode === 'eye' && house) {
    // walk around with WASD/arrows too — moves the house itself (at a walking
    // pace, not a fly-around pace), so you can explore the garden while
    // staying at eye level; the table/minimap/horizon panel catch up via the
    // periodic updateAll() below (no need to redo those heavy canvases every frame).
    const walkSpeed = (keys['ShiftLeft'] || keys['ShiftRight'] ? 3 : 1) * 9; // m/s — brisk walk, Maj = jog
    const f = forwardVector(yaw, 0), r = rightVector(yaw); // horizontal only — looking up/down shouldn't tilt walking
    let mvx = 0, mvz = 0;
    if (keys['KeyW'] || keys['ArrowUp']) { mvx += f.x; mvz += f.z; }
    if (keys['KeyS'] || keys['ArrowDown']) { mvx -= f.x; mvz -= f.z; }
    if (keys['KeyD'] || keys['ArrowRight']) { mvx += r.x; mvz += r.z; }
    if (keys['KeyA'] || keys['ArrowLeft']) { mvx -= r.x; mvz -= r.z; }
    if (mvx || mvz) {
      const len = Math.hypot(mvx, mvz);
      const nx = house.x + (mvx / len) * walkSpeed * dt;
      const nz = house.z + (mvz / len) * walkSpeed * dt;
      house.x = nx; house.z = nz;
      house.groundElev = elevationAt(nx, nz);
      houseMesh.position.set(nx, displayElevationAt(nx, nz), nz);
      if (osmHouseMarker) osmHouseMarker.setLatLng(worldToLatlon(nx, nz));
    }
    camera.position.set(house.x, displayElevationAt(house.x, house.z) + house.eyeHeight, house.z);
  }

  // aviation beacon: ~1s cycle, brief bright flash (real obstruction lights are a short
  // flash, not 50/50 on-off) — synchronised across all turbines, as most real installs are.
  const blinkOn = (now % 1000) < 220;
  for (const id of TURBINE_IDS) {
    const t = turbineMeshes[id];
    t.rotor.rotation.z += dt * 0.35;
    t.beacon.material.color.setHex(blinkOn ? 0xff2020 : 0x4a0808);
    t.beaconGlow.intensity = blinkOn ? 2.5 : 0;
  }

  updateLabels();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------------------
// Visibility / horizon math
// ---------------------------------------------------------------------------
function horizonAngle(eyeX, eyeZ, eyeElevAbs, targetX, targetZ, maxDist, stepHint) {
  const dx = targetX - eyeX, dz = targetZ - eyeZ;
  const dist = Math.hypot(dx, dz);
  const d = Math.min(dist, maxDist ?? dist);
  const ux = dx / dist, uz = dz / dist;
  const step = stepHint || Math.max(15, d / 120);
  let maxAngle = -Infinity;
  for (let t = Math.min(25, d * 0.3); t <= d; t += step) {
    const px = eyeX + ux * t, pz = eyeZ + uz * t;
    const elev = elevationAt(px, pz);
    const drop = (t * t) / (2 * EARTH_EFFECTIVE_RADIUS);
    const ang = Math.atan2(elev - drop - eyeElevAbs, t);
    if (ang > maxAngle) maxAngle = ang;
  }
  if (maxAngle === -Infinity) maxAngle = 0;
  return maxAngle;
}

function computeTurbineStats(id) {
  if (!house) return null;
  const tb = turbineMeshes[id].base;
  const eyeElev = house.groundElev + house.eyeHeight;
  const dx = tb.x - house.x, dz = tb.z - house.z;
  const distance = Math.hypot(dx, dz);
  const north = -dz;
  let bearing = Math.atan2(dx, north) * DEG;
  if (bearing < 0) bearing += 360;

  const baseElev = tb.elev;
  const hubElev = baseElev + params.hubHeight;
  const tipElev = baseElev + params.totalHeight;

  const angBase = Math.atan2(baseElev - eyeElev, distance) * DEG;
  const angHub = Math.atan2(hubElev - eyeElev, distance) * DEG;
  const angTip = Math.atan2(tipElev - eyeElev, distance) * DEG;

  const horizonRad = horizonAngle(house.x, house.z, eyeElev, tb.x, tb.z, distance);
  const horizonDeg = horizonRad * DEG;

  let visibleFraction, status;
  if (angTip <= horizonDeg) {
    visibleFraction = 0; status = 'hidden';
  } else if (angBase >= horizonDeg) {
    visibleFraction = 1; status = 'visible';
  } else {
    const cutElev = eyeElev + Math.tan(horizonRad) * distance;
    const visibleHeight = tipElev - cutElev;
    visibleFraction = Math.max(0, Math.min(1, visibleHeight / params.totalHeight));
    status = 'partial';
  }

  return {
    id, distance, bearing, denivele: baseElev - house.groundElev,
    angBase, angHub, angTip, horizonDeg, visibleFraction, status,
    baseElev, hubElev, tipElev, eyeElev
  };
}

function updateAll() {
  renderTable();
  renderHorizonCanvas();
  renderMiniMap();
}

// ---------------------------------------------------------------------------
// UI: table
// ---------------------------------------------------------------------------
const tbody = document.querySelector('#turbineTable tbody');
function statusLabel(s, frac) {
  if (s === 'visible') return '<span class="status-visible">Visible (100%)</span>';
  if (s === 'hidden') return '<span class="status-hidden">Masqué (0%)</span>';
  return `<span class="status-partial">Partiel (${Math.round(frac * 100)}%)</span>`;
}
function renderTable() {
  tbody.innerHTML = '';
  for (const id of TURBINE_IDS) {
    const s = computeTurbineStats(id);
    if (!s) continue;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${id}</td><td>${s.distance.toFixed(0)} m</td><td>${s.denivele >= 0 ? '+' : ''}${s.denivele.toFixed(0)} m</td>` +
      `<td>${s.bearing.toFixed(0)}°</td><td>${s.angHub.toFixed(1)}°</td><td>${statusLabel(s.status, s.visibleFraction)}</td>`;
    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// UI: horizon panorama canvas
// ---------------------------------------------------------------------------
const hCanvas = document.getElementById('horizonCanvas');
const hCtx = hCanvas.getContext('2d');
function renderHorizonCanvas() {
  if (!house) return;
  const stats = TURBINE_IDS.map(computeTurbineStats);
  let minB = Math.min(...stats.map(s => s.bearing)) - 6;
  let maxB = Math.max(...stats.map(s => s.bearing)) + 6;
  if (maxB - minB < 20) { const c = (minB + maxB) / 2; minB = c - 10; maxB = c + 10; }

  const W = hCanvas.width, H = hCanvas.height;
  hCtx.clearRect(0, 0, W, H);

  const maxTip = Math.max(...stats.map(s => s.angTip));
  const minAng = Math.min(-2, Math.min(...stats.map(s => s.angBase)) - 2);
  const maxAng = Math.max(6, maxTip + 2);

  const bx = (b) => ((b - minB) / (maxB - minB)) * W;
  const ay = (a) => H - ((a - minAng) / (maxAng - minAng)) * H;

  // horizon line
  hCtx.strokeStyle = '#7fae86';
  hCtx.lineWidth = 2;
  hCtx.beginPath();
  const eyeElev = house.groundElev + house.eyeHeight;
  const N = 90;
  for (let i = 0; i <= N; i++) {
    const b = minB + (maxB - minB) * (i / N);
    const rad = b / DEG;
    const north = Math.cos(rad), east = Math.sin(rad);
    const dz = -north, dx = east;
    const maxRange = Math.min(6000, G.half / Math.max(0.05, Math.max(Math.abs(dx), Math.abs(dz))));
    const ang = horizonAngle(house.x, house.z, eyeElev, house.x + dx * maxRange, house.z + dz * maxRange, maxRange) * DEG;
    const X = bx(b), Y = ay(ang);
    if (i === 0) hCtx.moveTo(X, Y); else hCtx.lineTo(X, Y);
  }
  hCtx.lineTo(W, H); hCtx.lineTo(0, H); hCtx.closePath();
  hCtx.fillStyle = 'rgba(90,120,80,0.35)';
  hCtx.fill();
  hCtx.stroke();

  // 0-degree reference line
  hCtx.strokeStyle = 'rgba(255,255,255,0.15)';
  hCtx.beginPath(); hCtx.moveTo(0, ay(0)); hCtx.lineTo(W, ay(0)); hCtx.stroke();

  // turbines
  for (const s of stats) {
    const X = bx(s.bearing);
    const halfW = Math.max(3, W * 0.012);
    const color = s.status === 'visible' ? '#6fe08a' : s.status === 'partial' ? '#e0b96f' : '#e07070';
    hCtx.fillStyle = color;
    hCtx.globalAlpha = 0.85;
    hCtx.fillRect(X - halfW / 2, ay(s.angTip), halfW, ay(s.angBase) - ay(s.angTip));
    hCtx.globalAlpha = 1;
    hCtx.fillStyle = '#fff';
    hCtx.font = '10px sans-serif';
    hCtx.textAlign = 'center';
    hCtx.fillText(s.id, X, ay(s.angTip) - 4);
  }
}

// ---------------------------------------------------------------------------
// UI: minimap
// ---------------------------------------------------------------------------
const mCanvas = document.getElementById('miniMap');
const mCtx = mCanvas.getContext('2d');
function renderMiniMap() {
  const W = mCanvas.width, H = mCanvas.height;
  mCtx.clearRect(0, 0, W, H);
  const range = G.half;
  const px = (x) => (x + range) / (2 * range) * W;
  const py = (z) => (z + range) / (2 * range) * H; // z = south -> down on map = south, matches north-up view

  // terrain elevation shading
  const img = mCtx.createImageData(W, H);
  const n = G.n;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const wx = (i / W) * 2 * range - range;
      const wz = (j / H) * 2 * range - range;
      const e = elevationAt(wx, wz);
      const t = (e - ELEV_MIN) / Math.max(1, ELEV_MAX - ELEV_MIN);
      const idx = (j * W + i) * 4;
      img.data[idx] = 60 + t * 110;
      img.data[idx + 1] = 90 + t * 70;
      img.data[idx + 2] = 55 + t * 40;
      img.data[idx + 3] = 255;
    }
  }
  mCtx.putImageData(img, 0, 0);

  // villages
  mCtx.font = '9px sans-serif';
  mCtx.fillStyle = '#bcd7ea';
  for (const [name, pt] of Object.entries(SITE.villages)) {
    const w = toWorld(pt);
    if (Math.abs(w.x) > range || Math.abs(w.z) > range) continue;
    const X = px(w.x), Y = py(w.z);
    mCtx.beginPath(); mCtx.arc(X, Y, 2, 0, 7); mCtx.fill();
    mCtx.fillText(name, X + 4, Y + 3);
  }

  // turbines
  for (const id of TURBINE_IDS) {
    const b = turbineMeshes[id].base;
    const X = px(b.x), Y = py(b.z);
    mCtx.fillStyle = '#e07070';
    mCtx.beginPath(); mCtx.arc(X, Y, 3, 0, 7); mCtx.fill();
    mCtx.fillStyle = '#fff';
    mCtx.fillText(id, X + 4, Y - 4);
  }

  // house + camera heading
  if (house) {
    const X = px(house.x), Y = py(house.z);
    mCtx.fillStyle = '#ffd35c';
    mCtx.beginPath(); mCtx.arc(X, Y, 4, 0, 7); mCtx.fill();
    const len = 16;
    const fx = Math.sin(yaw) * len, fz = -Math.cos(yaw) * len;
    mCtx.strokeStyle = '#ffd35c'; mCtx.lineWidth = 2;
    mCtx.beginPath(); mCtx.moveTo(X, Y); mCtx.lineTo(X + fx, Y + fz); mCtx.stroke();
  }

  // north arrow
  mCtx.fillStyle = '#fff';
  mCtx.fillText('N ↑', W - 22, 12);
}

// ---------------------------------------------------------------------------
// UI: 3D floating labels
// ---------------------------------------------------------------------------
const labelLayer = document.getElementById('turbineLabels');
const labelEls = {};
for (const id of TURBINE_IDS) {
  const el = document.createElement('div');
  el.className = 'tlabel';
  labelLayer.appendChild(el);
  labelEls[id] = el;
}
const eiffelLabelEl = document.createElement('div');
eiffelLabelEl.className = 'tlabel';
labelLayer.appendChild(eiffelLabelEl);
const humanLabelEl = document.createElement('div');
humanLabelEl.className = 'tlabel';
labelLayer.appendChild(humanLabelEl);
const carLabelEl = document.createElement('div');
carLabelEl.className = 'tlabel';
labelLayer.appendChild(carLabelEl);
const showLabels = () => document.getElementById('chkLabels').checked;

function updateEiffelLabel() {
  if (!showLabels() || !eiffelGroup.visible) { eiffelLabelEl.style.display = 'none'; return; }
  const top = new THREE.Vector3(EIFFEL_WORLD.x, eiffelGroup.position.y + EIFFEL_HEIGHT, EIFFEL_WORLD.z);
  const proj = top.clone().project(camera);
  if (proj.z > 1 || proj.z < -1) { eiffelLabelEl.style.display = 'none'; return; }
  const sx = (proj.x * 0.5 + 0.5) * innerWidth;
  const sy = (-proj.y * 0.5 + 0.5) * innerHeight;
  if (sx < -50 || sx > innerWidth + 50 || sy < -50 || sy > innerHeight + 50) { eiffelLabelEl.style.display = 'none'; return; }
  eiffelLabelEl.style.display = 'block';
  eiffelLabelEl.style.left = sx + 'px';
  eiffelLabelEl.style.top = sy + 'px';
  eiffelLabelEl.innerHTML = `🗼 Tour Eiffel <span class="d">${EIFFEL_HEIGHT} m</span>`;
}

function updateHumanLabel() {
  if (!showLabels() || !humanGroup.visible) { humanLabelEl.style.display = 'none'; return; }
  const top = new THREE.Vector3(humanWorld.x, humanInstances[0].group.position.y + HUMAN_HEIGHT, humanWorld.z);
  const proj = top.clone().project(camera);
  if (proj.z > 1 || proj.z < -1) { humanLabelEl.style.display = 'none'; return; }
  const sx = (proj.x * 0.5 + 0.5) * innerWidth;
  const sy = (-proj.y * 0.5 + 0.5) * innerHeight;
  if (sx < -50 || sx > innerWidth + 50 || sy < -50 || sy > innerHeight + 50) { humanLabelEl.style.display = 'none'; return; }
  humanLabelEl.style.display = 'block';
  humanLabelEl.style.left = sx + 'px';
  humanLabelEl.style.top = sy + 'px';
  humanLabelEl.innerHTML = `🚶 <span class="d">${HUMAN_HEIGHT} m</span>`;
}

function updateCarLabel() {
  if (!showLabels() || !carGroup.visible) { carLabelEl.style.display = 'none'; return; }
  const top = new THREE.Vector3(carWorld.x, carInstances[0].group.position.y + CAR_HEIGHT, carWorld.z);
  const proj = top.clone().project(camera);
  if (proj.z > 1 || proj.z < -1) { carLabelEl.style.display = 'none'; return; }
  const sx = (proj.x * 0.5 + 0.5) * innerWidth;
  const sy = (-proj.y * 0.5 + 0.5) * innerHeight;
  if (sx < -50 || sx > innerWidth + 50 || sy < -50 || sy > innerHeight + 50) { carLabelEl.style.display = 'none'; return; }
  carLabelEl.style.display = 'block';
  carLabelEl.style.left = sx + 'px';
  carLabelEl.style.top = sy + 'px';
  carLabelEl.innerHTML = `🚗 <span class="d">${CAR_LENGTH} m</span>`;
}

function updateLabels() {
  const visible = showLabels();
  for (const id of TURBINE_IDS) {
    const el = labelEls[id];
    if (!visible) { el.style.display = 'none'; continue; }
    const b = turbineMeshes[id].base;
    const hubWorld = new THREE.Vector3(b.x, b.elev + params.hubHeight, b.z);
    const proj = hubWorld.clone().project(camera);
    if (proj.z > 1 || proj.z < -1) { el.style.display = 'none'; continue; }
    const sx = (proj.x * 0.5 + 0.5) * innerWidth;
    const sy = (-proj.y * 0.5 + 0.5) * innerHeight;
    if (sx < -50 || sx > innerWidth + 50 || sy < -50 || sy > innerHeight + 50) { el.style.display = 'none'; continue; }
    const s = computeTurbineStats(id);
    el.className = 'tlabel' + (s.status === 'hidden' ? ' hidden-lbl' : s.status === 'partial' ? ' partial-lbl' : '');
    el.style.display = 'block';
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    el.innerHTML = `${id} <span class="d">${s.distance.toFixed(0)} m · ${s.status === 'visible' ? '100%' : s.status === 'hidden' ? '0%' : Math.round(s.visibleFraction * 100) + '%'}</span>`;
  }
  updateEiffelLabel();
  updateHumanLabel();
  updateCarLabel();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
document.getElementById('btnCollapse').addEventListener('click', () => {
  document.getElementById('panel').classList.toggle('collapsed');
});

// on narrow (phone-ish) screens, start with the side panel and the floating
// map collapsed so the 3D view itself isn't squeezed into a sliver — both
// stay one tap away via their usual toggle buttons.
if (innerWidth < 640) {
  document.getElementById('panel').classList.add('collapsed');
  document.getElementById('miniMapFloat').classList.add('collapsed');
  document.getElementById('btnToggleMiniMap').textContent = '+';
}

document.getElementById('btnPlaceHouse').addEventListener('click', (e) => {
  placingHouse = !placingHouse;
  e.target.textContent = placingHouse ? '➡️ Cliquez sur le terrain…' : '📍 Cliquer sur le terrain pour placer la maison';
  document.getElementById('crosshair').classList.toggle('show', placingHouse);
});

const btnFree = document.getElementById('btnFreeMode');
const btnEye = document.getElementById('btnEyeMode');
btnFree.addEventListener('click', () => {
  mode = 'free'; btnFree.classList.add('active'); btnEye.classList.remove('active');
  houseMesh.visible = true; // seen from outside now that the camera has left it
  if (house) camera.position.set(house.x, displayElevationAt(house.x, house.z) + 40, house.z + 150);
});
btnEye.addEventListener('click', () => {
  mode = 'eye'; btnEye.classList.add('active'); btnFree.classList.remove('active');
  houseMesh.visible = false; // the camera sits exactly at/inside the house marker in this mode —
  // rendering it would just show its (unlit, near-black) inside faces filling the view.
});

const eyeHeightInput = document.getElementById('eyeHeight');
const eyeHeightVal = document.getElementById('eyeHeightVal');
eyeHeightInput.addEventListener('input', () => {
  const v = parseFloat(eyeHeightInput.value);
  eyeHeightVal.textContent = v.toFixed(1) + ' m';
  if (house) { house.eyeHeight = v; updateAll(); }
});

// ---------------------------------------------------------------------------
// Sun / time-of-day UI
// ---------------------------------------------------------------------------
const sunDateInput = document.getElementById('sunDate');
const sunTimeInput = document.getElementById('sunTime');
const sunTimeVal = document.getElementById('sunTimeVal');

function hourFloatToLabel(h) {
  const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}
function refreshSun() {
  sunTimeVal.textContent = hourFloatToLabel(parseFloat(sunTimeInput.value));
  updateSun(sunDateInput.value, parseFloat(sunTimeInput.value));
}
sunDateInput.addEventListener('input', refreshSun);
sunTimeInput.addEventListener('input', refreshSun);

const sunPresetRow = document.getElementById('sunPresetRow');
function addSunPreset(label, date, hour) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', () => {
    sunDateInput.value = date;
    sunTimeInput.value = hour;
    refreshSun();
  });
  sunPresetRow.appendChild(btn);
}
addSunPreset('21 juin, 20h00', '2026-06-21', 20);
addSunPreset('21 juin, 21h00', '2026-06-21', 21);
addSunPreset('21 juin, 22h00', '2026-06-21', 22);
addSunPreset('21 déc, 12h00 (hiver)', '2026-12-21', 12);

document.getElementById('chkShadows').addEventListener('change', (e) => {
  renderer.shadowMap.enabled = e.target.checked;
  sun.castShadow = e.target.checked;
});

let sunPlaying = false;
document.getElementById('btnSunPlay').addEventListener('click', (e) => {
  sunPlaying = !sunPlaying;
  e.target.textContent = sunPlaying ? '⏸ Pause' : '▶ Jouer la journée';
});

refreshSun(); // initial render at the default date/time above

// ---------------------------------------------------------------------------
// OSM map (Leaflet) — real map context, click or drag the house icon to move it.
// ---------------------------------------------------------------------------
{
  const startLatLon = worldToLatlon(INITIAL_HOUSE_WORLD.x, INITIAL_HOUSE_WORLD.z);
  const map = L.map('osmMap', { zoomControl: true }).setView(startLatLon, 15);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  osmMap = map;

  for (const id of TURBINE_IDS) {
    const t = SITE.turbines[id];
    L.circle([t.lat, t.lon], {
      radius: 1000, color: '#c0392b', weight: 1.5, opacity: 0.7, fill: false, dashArray: '6 5',
    }).addTo(map);
    L.circleMarker([t.lat, t.lon], { radius: 5, className: 'turbine-icon' })
      .addTo(map)
      .bindTooltip(id, { permanent: true, direction: 'top', offset: [0, -4], className: 'turbine-label' });
  }

  // a bigger invisible touch target than the visible emoji itself — a 22x22px
  // hit area is hard to grab precisely with a finger (mobile: dragging it to
  // move the house didn't work reliably); 44x44 meets the usual touch-target
  // guideline while the emoji itself stays visually the same size, centred.
  const houseIcon = L.divIcon({ html: '🏠', className: 'house-icon', iconSize: [44, 44], iconAnchor: [22, 34] });
  osmHouseMarker = L.marker(startLatLon, { icon: houseIcon, draggable: true }).addTo(map);

  // free-fly camera position + heading, shown only in "vue libre" mode (in
  // "vue depuis la maison" the camera IS the house marker above)
  const cameraIcon = L.divIcon({ html: '<div class="cam-arrow">▲</div>', className: 'cam-icon', iconSize: [20, 20], iconAnchor: [10, 10] });
  osmCameraMarker = L.marker(startLatLon, { icon: cameraIcon, interactive: false }).addTo(map);
  osmCameraMarker.getElement().style.display = 'none';

  function placeFromLatLng(latlng) {
    const w = latlonToWorld(latlng.lat, latlng.lng);
    setHouse(w.x, w.z, house ? house.eyeHeight : 1.6, /* panMap= */ false);
  }
  osmHouseMarker.on('dragend', (e) => placeFromLatLng(e.target.getLatLng()));
  map.on('click', (e) => placeFromLatLng(e.latlng));

  // Leaflet needs a resize kick once its container has its final on-screen size,
  // and again whenever it's revealed after being hidden (collapse toggle below).
  setTimeout(() => map.invalidateSize(), 300);
  document.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => map.invalidateSize()));

  const floatEl = document.getElementById('miniMapFloat');
  document.getElementById('btnToggleMiniMap').addEventListener('click', (e) => {
    const collapsed = floatEl.classList.toggle('collapsed');
    e.target.textContent = collapsed ? '+' : '–';
    if (!collapsed) setTimeout(() => map.invalidateSize(), 50);
  });
}

// preset locations — each a full bookmarked view (position + look direction +
// sun date/time), i.e. exactly what "Copier le lien de cette vue" produces.
const presetRow = document.getElementById('presetRow');
function addBookmarkPreset(label, view) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', () => applyView(view));
  presetRow.appendChild(btn);
}
addBookmarkPreset('🚜 Ferme de Beauffaux (parking)', {
  lat: 50.550424, lon: 4.759212, h: 1.6, yaw: 180.9, pitch: 9.7, mode: 'eye', date: '2026-06-21', time: 21.90,
});
addBookmarkPreset('🏡 Maison à Saint-Denis (vue jardin)', {
  lat: 50.541786, lon: 4.775642, h: 1.6, yaw: 288.4, pitch: 11.1, mode: 'eye', date: '2026-06-21', time: 19.25,
});
addBookmarkPreset('🛣️ Rue des Quatre Vents (Beuzet)', {
  lat: 50.537119, lon: 4.746962, h: 1.6, yaw: 84.8, pitch: 13.9, mode: 'eye', date: '2026-06-21', time: 19.25,
});
addBookmarkPreset('🌬️ Milieu du parc (rue de la Bolette)', {
  lat: 50.538373, lon: 4.765999, h: 1.6, yaw: 300.0, pitch: 24.0, mode: 'eye', date: '2026-12-21', time: 12.80,
});
addBookmarkPreset('🏘️ Bovesse', {
  lat: 50.519295, lon: 4.780312, h: 1.6, yaw: 319.5, pitch: 2.6, mode: 'eye', date: '2026-12-21', time: 12.80,
});
addBookmarkPreset('🚁 Vue d\'ensemble (aérienne)', {
  lat: 50.538181, lon: 4.783969, h: 224.4, yaw: 260.2, pitch: -16.5, mode: 'free', date: '2026-12-21', time: 14.60,
});
addBookmarkPreset('🌙 De nuit', {
  lat: 50.556751, lon: 4.747126, h: 51.0, yaw: 156.8, pitch: 13.2, mode: 'free', date: '2026-12-21', time: 0.00,
});

// look-at buttons
const lookButtons = document.getElementById('lookButtons');
for (const id of TURBINE_IDS) {
  const btn = document.createElement('button');
  btn.textContent = '👁 ' + id;
  btn.addEventListener('click', () => {
    const b = turbineMeshes[id].base;
    const hubWorld = { x: b.x, z: b.z };
    const from = mode === 'eye' && house ? { x: house.x, z: house.z } : { x: camera.position.x, z: camera.position.z };
    const eyeY = mode === 'eye' && house ? house.groundElev + house.eyeHeight : camera.position.y;
    yaw = bearingTo(from, hubWorld);
    const dist = Math.hypot(b.x - from.x, b.z - from.z);
    const targetY = b.elev + params.hubHeight;
    pitch = Math.atan2(targetY - eyeY, dist);
  });
  lookButtons.appendChild(btn);
}

// turbine params — size reference points taken from sizes.jpg (evolution of
// onshore turbine height by generation/power class, y-axis = tip height, plus
// the Eiffel Tower for scale). Hub heights aren't in that chart — estimated
// from the total height (~62-65%), a typical real-world ratio; pick
// "Personnalisé" to type exact numbers from an actual project's spec sheet.
const TURBINE_MODELS = [
  // official spec for the actual studied model (D = rotor diameter, H = tip height)
  { label: '✅ Modèle étudié (D=162 m, H=230 m)', hub: 230 - 81, total: 230 },
  { label: '2010 (~3 MW) — 90 m', hub: 58, total: 90 },
  { label: '2013 (~6 MW) — 151 m', hub: 98, total: 151 },
  { label: '2016 (~8 MW) — 164 m', hub: 106, total: 164 },
  { label: '2021 (~12 MW) — 220 m', hub: 140, total: 220 },
  { label: '2030* (15-20 MW) — 230 m (bas de fourchette)', hub: 150, total: 230 },
  { label: '2030* (15-20 MW) — 250 m (haut de fourchette)', hub: 163, total: 250 },
  { label: 'Personnalisé', hub: null, total: null },
];
const turbineModelSelect = document.getElementById('turbineModel');
for (const m of TURBINE_MODELS) {
  const opt = document.createElement('option');
  opt.textContent = m.label;
  turbineModelSelect.appendChild(opt);
}
turbineModelSelect.selectedIndex = 0; // the actual studied model, matches the default 230/149

const totalHeightInput = document.getElementById('totalHeight');
const hubHeightInput = document.getElementById('hubHeight');
function onParamsChange() {
  params.totalHeight = parseFloat(totalHeightInput.value) || 230;
  params.hubHeight = parseFloat(hubHeightInput.value) || 150;
  buildTurbines();
  updateAll();
}
totalHeightInput.addEventListener('input', () => { turbineModelSelect.selectedIndex = TURBINE_MODELS.length - 1; onParamsChange(); });
hubHeightInput.addEventListener('input', () => { turbineModelSelect.selectedIndex = TURBINE_MODELS.length - 1; onParamsChange(); });
turbineModelSelect.addEventListener('change', () => {
  const m = TURBINE_MODELS[turbineModelSelect.selectedIndex];
  if (m.total == null) return; // "Personnalisé" — leave current values as-is
  totalHeightInput.value = m.total;
  hubHeightInput.value = m.hub;
  onParamsChange();
});

// terrain display
const exagInput = document.getElementById('exaggeration');
const exagVal = document.getElementById('exagVal');
function applyExaggeration(v) {
  buildTerrain(v); // also updates currentExaggeration, used by displayElevationAt()
  setGroundTextureMode(groundTextureMode); // rebuilt terrain -> reapply whichever ground texture was active
  buildTurbines(); // cheap (6 turbines) -> keep them sitting exactly on the (possibly exaggerated) ground
  buildVillageMarkers(); // cheap (a handful of posts)
  if (eiffelGroup) eiffelGroup.position.y = displayElevationAt(EIFFEL_WORLD.x, EIFFEL_WORLD.z);
  for (const h of humanInstances) h.group.position.y = displayElevationAt(h.x, h.z);
  for (const c of carInstances) c.group.position.y = displayElevationAt(c.x, c.z);
  if (house) houseMesh.position.y = displayElevationAt(house.x, house.z);
}
exagInput.addEventListener('input', () => {
  const v = parseFloat(exagInput.value);
  exagVal.textContent = v.toFixed(1) + '×';
  applyExaggeration(v);
});
// buildings (~8000 footprints) are comparatively expensive to rebuild, so they
// only get repositioned once the user releases the slider, not on every tick.
exagInput.addEventListener('change', () => { buildBuildings(); layoutVegetation(); });
document.getElementById('chkWireframe').addEventListener('change', (e) => {
  for (const mat of Object.values(CROP_MATERIALS)) mat.wireframe = e.target.checked;
  satelliteMaterial.wireframe = e.target.checked;
});
for (const radio of document.querySelectorAll('input[name="groundTexture"]')) {
  radio.addEventListener('change', (e) => { if (e.target.checked) setGroundTextureMode(e.target.value); });
}
document.getElementById('chkBuildings').addEventListener('change', (e) => {
  buildingsGroup.visible = e.target.checked;
});
document.getElementById('chkVegetation').addEventListener('change', (e) => {
  vegetationGroup.visible = e.target.checked;
});
document.getElementById('chkEiffel').addEventListener('change', (e) => {
  eiffelGroup.visible = e.target.checked;
});
document.getElementById('chkHuman').addEventListener('change', (e) => {
  humanGroup.visible = e.target.checked;
});
document.getElementById('chkCar').addEventListener('change', (e) => {
  carGroup.visible = e.target.checked;
});

// periodic recompute (covers camera moves affecting nothing else, cheap safety net)
setInterval(updateAll, 400);

// ---------------------------------------------------------------------------
// Shareable link — bookmarks the current viewpoint (lat/lon, height above
// ground, look direction, mode) as URL query params, so the link alone
// reproduces the exact view for whoever opens it.
// ---------------------------------------------------------------------------
// Applies a full bookmarked view: {lat, lon, h, yaw, pitch, mode, date, time}
// (all optional except lat/lon; same fields as the URL query params — values
// may be strings or numbers, either works since everything is parseFloat'd).
// Shared by the URL-restore-on-load logic and any preset button that wants to
// jump to a specific position *and* look direction *and* time of day at once.
function applyView(p) {
  const lat = parseFloat(p.lat), lon = parseFloat(p.lon);
  if (!isFinite(lat) || !isFinite(lon)) return false;
  const h = parseFloat(p.h);
  const eyeH = isFinite(h) ? h : 1.6;
  const yawDeg = parseFloat(p.yaw);
  const pitchDeg = parseFloat(p.pitch);
  yaw = (isFinite(yawDeg) ? yawDeg : 0) * (Math.PI / 180);
  pitch = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, (isFinite(pitchDeg) ? pitchDeg : 0) * (Math.PI / 180)));
  const w = latlonToWorld(lat, lon);

  if (p.mode === 'free') {
    mode = 'free'; btnFree.classList.add('active'); btnEye.classList.remove('active');
    houseMesh.visible = true;
    camera.position.set(w.x, displayElevationAt(w.x, w.z) + eyeH, w.z);
    updateAll();
  } else {
    mode = 'eye'; btnEye.classList.add('active'); btnFree.classList.remove('active');
    eyeHeightInput.value = eyeH;
    eyeHeightVal.textContent = eyeH.toFixed(1) + ' m';
    setHouse(w.x, w.z, eyeH, false);
  }

  // optional: date/time of day, so the sun/shadows match what was bookmarked too
  const date = p.date, time = parseFloat(p.time);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) sunDateInput.value = date;
  if (isFinite(time)) sunTimeInput.value = time;
  if (date || isFinite(time)) refreshSun();

  return true;
}

function applyViewFromUrl() {
  const params = new URLSearchParams(location.search);
  if (!params.has('lat') || !params.has('lon')) return false;
  return applyView(Object.fromEntries(params));
}

function buildShareUrl() {
  const url = new URL(location.href);
  url.search = '';
  let lat, lon, h;
  if (mode === 'free') {
    [lat, lon] = worldToLatlon(camera.position.x, camera.position.z);
    h = camera.position.y - displayElevationAt(camera.position.x, camera.position.z);
  } else if (house) {
    [lat, lon] = worldToLatlon(house.x, house.z);
    h = house.eyeHeight;
  } else {
    return url.toString();
  }
  url.searchParams.set('lat', lat.toFixed(6));
  url.searchParams.set('lon', lon.toFixed(6));
  url.searchParams.set('h', h.toFixed(1));
  url.searchParams.set('yaw', (((yaw * DEG) % 360 + 360) % 360).toFixed(1));
  url.searchParams.set('pitch', (pitch * DEG).toFixed(1));
  url.searchParams.set('mode', mode);
  url.searchParams.set('date', sunDateInput.value);
  url.searchParams.set('time', parseFloat(sunTimeInput.value).toFixed(2));
  return url.toString();
}

document.getElementById('btnShareLink').addEventListener('click', async (e) => {
  const url = buildShareUrl();
  history.replaceState(null, '', url);
  const btn = e.currentTarget;
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = '✅ Lien copié !';
  } catch (err) {
    window.prompt('Copiez ce lien :', url); // clipboard API unavailable (e.g. file://, insecure context)
    btn.textContent = '🔗 Lien prêt (voir ci-dessus)';
  }
  setTimeout(() => { btn.textContent = old; }, 2000);
});

// now that every UI element exists, place the house for real (triggers first
// render) — unless the URL already bookmarks a specific viewpoint to restore.
if (!applyViewFromUrl()) {
  setHouse(INITIAL_HOUSE_WORLD.x, INITIAL_HOUSE_WORLD.z, 1.6);
}

// keep the address bar itself live-synced to the current viewpoint (position,
// direction, mode, sun date/time) as it changes — no need to press the share
// button just to get a shareable/refreshable URL; replaceState doesn't touch
// browser history so this never breaks the back button.
let lastSyncedUrl = '';
setInterval(() => {
  const url = buildShareUrl();
  if (url !== lastSyncedUrl) { lastSyncedUrl = url; history.replaceState(null, '', url); }
}, 600);
