// Geometría y proyecciones, sin dependencias. Funciona igual en el navegador y en Node.
//
// Convenciones:
//   - Una geometría es un multipolígono: [poligono, ...]; un polígono es [anillo, ...]
//     (el primero es el exterior, el resto huecos); un anillo es [[x, y], ...].
//   - En longitud/latitud el orden es siempre [lon, lat] en grados (WGS84/ETRS89).

const A = 6378137.0;
const F = 1 / 298.257222101; // GRS80; la diferencia con WGS84 es inferior al milímetro
const N = F / (2 - F);
const A_RECT = (A / (1 + N)) * (1 + (N * N) / 4 + N ** 4 / 64);
const ALFA = [N / 2 - (2 * N * N) / 3 + (5 * N ** 3) / 16, (13 * N * N) / 48 - (3 * N ** 3) / 5, (61 * N ** 3) / 240];
const BETA = [N / 2 - (2 * N * N) / 3 + (37 * N ** 3) / 96, (N * N) / 48 + N ** 3 / 15, (17 * N ** 3) / 480];
const DELTA = [2 * N - (2 * N * N) / 3 - 2 * N ** 3, (7 * N * N) / 3 - (8 * N ** 3) / 5, (56 * N ** 3) / 15];
const RAD = Math.PI / 180;
const E_AUX = (2 * Math.sqrt(N)) / (1 + N);

/** Transversa de Mercator directa (serie de Krüger). Devuelve [este, norte] en metros sin falsos orígenes. */
export function tmDirecta(lon, lat, lon0, k0 = 1) {
  const fi = lat * RAD;
  const dl = (lon - lon0) * RAD;
  const s = Math.sin(fi);
  const t = Math.sinh(Math.atanh(s) - E_AUX * Math.atanh(E_AUX * s));
  const xi = Math.atan2(t, Math.cos(dl));
  const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let e = eta;
  let n = xi;
  for (let j = 1; j <= 3; j++) {
    e += ALFA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    n += ALFA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [k0 * A_RECT * e, k0 * A_RECT * n];
}

/** Transversa de Mercator inversa. Recibe este y norte sin falsos orígenes. */
export function tmInversa(e, n, lon0, k0 = 1) {
  const xi = n / (k0 * A_RECT);
  const eta = e / (k0 * A_RECT);
  let xi1 = xi;
  let eta1 = eta;
  for (let j = 1; j <= 3; j++) {
    xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
  let fi = chi;
  for (let j = 1; j <= 3; j++) fi += DELTA[j - 1] * Math.sin(2 * j * chi);
  const lon = lon0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) / RAD;
  return [lon, fi / RAD];
}

export function husoUtm(lon) {
  return Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
}

/** Proyección UTM de un huso. `sur` añade el falso norte del hemisferio sur. */
export function utm(huso, sur = false) {
  const lon0 = huso * 6 - 183;
  const fn = sur ? 10000000 : 0;
  return {
    nombre: `UTM ${huso}${sur ? "S" : "N"}`,
    directa: (lon, lat) => {
      const [e, n] = tmDirecta(lon, lat, lon0, 0.9996);
      return [e + 500000, n + fn];
    },
    inversa: (x, y) => tmInversa(x - 500000, y - fn, lon0, 0.9996),
  };
}

/** Proyección a partir de un código EPSG de los que usan el Catastro, el IGN y Sentinel-2. */
export function proyeccionEpsg(epsg) {
  const c = Number(epsg);
  if (c >= 25828 && c <= 25838) return utm(c - 25800); // ETRS89 UTM
  if (c >= 32601 && c <= 32660) return utm(c - 32600); // WGS84 UTM norte
  if (c >= 32701 && c <= 32760) return utm(c - 32700, true); // WGS84 UTM sur
  if (c === 4083 || c === 4082) return utm(c === 4083 ? 28 : 27); // REGCAN95 UTM
  if (c === 3857 || c === 900913) return { nombre: "Web Mercator", directa: aMercator, inversa: deMercator };
  if (c === 4326 || c === 4258) return { nombre: "geográficas", directa: (lon, lat) => [lon, lat], inversa: (x, y) => [x, y] };
  throw new Error(`Sistema de referencia no admitido: EPSG:${epsg}`);
}

const R_MERC = 6378137;
export const MEDIO_MUNDO = Math.PI * R_MERC;
export function aMercator(lon, lat) {
  const l = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return [R_MERC * lon * RAD, R_MERC * Math.log(Math.tan(Math.PI / 4 + (l * RAD) / 2))];
}
export function deMercator(x, y) {
  return [x / R_MERC / RAD, (2 * Math.atan(Math.exp(y / R_MERC)) - Math.PI / 2) / RAD];
}
/** Tamaño en metros Mercator de un píxel de tesela de 256 px en el nivel z. */
export function resolucionMercator(z) {
  return (2 * MEDIO_MUNDO) / (256 * 2 ** z);
}

/** Proyección local en metros centrada en un punto: distancias y superficies reales cerca de él. */
export function proyeccionLocal(lon0, lat0) {
  const n0 = tmDirecta(lon0, lat0, lon0)[1];
  return {
    lon0,
    lat0,
    directa: (lon, lat) => {
      const [e, n] = tmDirecta(lon, lat, lon0);
      return [e, n - n0];
    },
    inversa: (x, y) => tmInversa(x, y + n0, lon0),
  };
}

// ------------------------------------------------------------------ geometría
export function transformar(geom, fn) {
  return geom.map((pol) => pol.map((anillo) => anillo.map(([x, y]) => fn(x, y))));
}

export function caja(geom) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pol of geom) for (const an of pol) for (const [x, y] of an) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function areaAnillo(an) {
  let s = 0;
  for (let i = 0, j = an.length - 1; i < an.length; j = i++) s += (an[j][0] + an[i][0]) * (an[j][1] - an[i][1]);
  return s / 2;
}

/** Superficie de un multipolígono en las unidades de sus coordenadas (exterior menos huecos). */
export function superficie(geom) {
  let s = 0;
  for (const pol of geom) pol.forEach((an, i) => (s += (i === 0 ? 1 : -1) * Math.abs(areaAnillo(an))));
  return s;
}

/**
 * Perímetro del contorno. Si el multipolígono son recintos contiguos (una parcela SIGPAC es
 * la lista de sus recintos), los lados que comparten dos recintos son interiores y no cuentan.
 */
export function perimetro(geom) {
  const lados = new Map();
  const red = (v) => Math.round(v * 1000); // al milímetro
  let p = 0;
  for (const pol of geom) for (const an of pol)
    for (let i = 0, j = an.length - 1; i < an.length; j = i++) {
      const largo = Math.hypot(an[i][0] - an[j][0], an[i][1] - an[j][1]);
      if (!largo) continue;
      p += largo;
      if (geom.length < 2) continue;
      const a = `${red(an[i][0])},${red(an[i][1])}`, b = `${red(an[j][0])},${red(an[j][1])}`;
      const clave = a < b ? `${a}|${b}` : `${b}|${a}`;
      const visto = lados.get(clave);
      if (visto) { p -= largo + visto; lados.delete(clave); } else lados.set(clave, largo);
    }
  return p;
}

/** ¿Está el punto dentro del multipolígono? Regla par-impar sobre todos los anillos. */
export function contiene(geom, x, y) {
  let dentro = false;
  for (const pol of geom) for (const an of pol)
    for (let i = 0, j = an.length - 1; i < an.length; j = i++) {
      const [xi, yi] = an[i];
      const [xj, yj] = an[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
  return dentro;
}

/**
 * Un punto que cae seguro dentro: el centroide si sirve; si no, el centro del tramo más ancho.
 * Si hay varios polígonos se toma el mayor, para que el punto no quede en el hueco entre ellos.
 */
export function puntoInterior(geomCompleta) {
  let geom = geomCompleta;
  if (geomCompleta.length > 1) {
    let mayor = geomCompleta[0], mejorArea = -1;
    for (const pol of geomCompleta) {
      const a = superficie([pol]);
      if (a > mejorArea) { mejorArea = a; mayor = pol; }
    }
    geom = [mayor];
  }
  let sx = 0, sy = 0, sw = 0;
  for (const pol of geom) pol.forEach((an, k) => {
    let ax = 0, ay = 0, af = 0;
    for (let i = 0, j = an.length - 1; i < an.length; j = i++) {
      const f = an[j][0] * an[i][1] - an[i][0] * an[j][1];
      ax += (an[j][0] + an[i][0]) * f;
      ay += (an[j][1] + an[i][1]) * f;
      af += f;
    }
    if (af === 0) return;
    const peso = (k === 0 ? 1 : -1) * Math.abs(af) / 2; // los huecos restan
    sx += peso * (ax / (3 * af));
    sy += peso * (ay / (3 * af));
    sw += peso;
  });
  if (sw > 0) {
    const c = [sx / sw, sy / sw];
    if (contiene(geom, c[0], c[1])) return c;
  }
  const [x0, y0, x1, y1] = caja(geom);
  let mejor = null;
  for (let k = 1; k <= 19; k++) {
    const y = y0 + ((y1 - y0) * k) / 20;
    const cortes = [];
    for (const pol of geom) for (const an of pol)
      for (let i = 0, j = an.length - 1; i < an.length; j = i++) {
        const [xi, yi] = an[i];
        const [xj, yj] = an[j];
        if (yi > y !== yj > y) cortes.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    cortes.sort((a, b) => a - b);
    for (let i = 0; i + 1 < cortes.length; i += 2) {
      const ancho = cortes[i + 1] - cortes[i];
      if (!mejor || ancho > mejor.ancho) mejor = { ancho, p: [(cortes[i] + cortes[i + 1]) / 2, y] };
    }
  }
  return mejor ? mejor.p : [(x0 + x1) / 2, (y0 + y1) / 2];
}

// -------------------------------------------------------------------- rejillas
/**
 * Rejilla regular que cubre una caja. La celda (i, j) tiene su centro en
 * x = x0 + (i + 0,5)·res, y = y1 − (j + 0,5)·res (la fila 0 es la del norte).
 */
export function crearRejilla([x0, y0, x1, y1], { maxCeldas = 1200000, resMin = 0.5, margen = 0, res = null } = {}) {
  x0 -= margen; y0 -= margen; x1 += margen; y1 += margen;
  const ancho = Math.max(x1 - x0, 1e-6);
  const alto = Math.max(y1 - y0, 1e-6);
  const r = res || Math.max(resMin, Math.sqrt((ancho * alto) / maxCeldas));
  const w = Math.max(1, Math.ceil(ancho / r));
  const h = Math.max(1, Math.ceil(alto / r));
  return { x0, y1, res: r, w, h };
}

/**
 * Máscara de las celdas cuyo centro cae dentro del multipolígono (1 dentro, 0 fuera).
 * `todoTocado` marca además las celdas que el contorno atraviesa (para recintos muy pequeños).
 */
export function rasterizar(geom, rej, { todoTocado = false } = {}) {
  const { x0, y1, res, w, h } = rej;
  const mascara = new Uint8Array(w * h);
  const filas = Array.from({ length: h }, () => []);
  for (const pol of geom) for (const an of pol)
    for (let i = 0, j = an.length - 1; i < an.length; j = i++) {
      let [xa, ya] = an[j];
      let [xb, yb] = an[i];
      if (ya === yb) continue;
      if (ya > yb) { [xa, ya, xb, yb] = [xb, yb, xa, ya]; }
      // filas cuyo centro queda entre ya (incluido) e yb (excluido)
      const jMax = Math.min(h - 1, Math.floor((y1 - ya) / res - 0.5));
      const jMin = Math.max(0, Math.ceil((y1 - yb) / res - 0.5 + 1e-12));
      for (let f = jMin; f <= jMax; f++) {
        const y = y1 - (f + 0.5) * res;
        if (y < ya || y >= yb) continue;
        filas[f].push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
      }
    }
  for (let f = 0; f < h; f++) {
    const xs = filas[f];
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / res - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / res - 0.5 - 1e-12));
      for (let i = i0; i <= i1; i++) mascara[f * w + i] = 1;
    }
  }
  if (todoTocado) {
    for (const pol of geom) for (const an of pol)
      for (let i = 0, j = an.length - 1; i < an.length; j = i++) {
        const [xa, ya] = an[j];
        const [xb, yb] = an[i];
        const pasos = Math.max(1, Math.ceil(Math.hypot(xb - xa, yb - ya) / (res / 2)));
        for (let k = 0; k <= pasos; k++) {
          const c = Math.floor((xa + ((xb - xa) * k) / pasos - x0) / res);
          const f = Math.floor((y1 - (ya + ((yb - ya) * k) / pasos)) / res);
          if (c >= 0 && c < w && f >= 0 && f < h) mascara[f * w + c] = 1;
        }
      }
  }
  return mascara;
}

export function contar(mascara) {
  let n = 0;
  for (let i = 0; i < mascara.length; i++) n += mascara[i];
  return n;
}

/**
 * Devuelve una función (i, j) → [X, Y] que lleva el centro de cada celda de la rejilla
 * a otro sistema de coordenadas. Calcula la transformación exacta en una malla de 5 × 5
 * nudos e interpola entre ellos: a escala de finca el error es de milímetros.
 */
export function mapeoRejilla(rej, fn) {
  const NUDOS = 4;
  const { x0, y1, res, w, h } = rej;
  const gx = new Float64Array((NUDOS + 1) * (NUDOS + 1));
  const gy = new Float64Array((NUDOS + 1) * (NUDOS + 1));
  for (let b = 0; b <= NUDOS; b++) for (let a = 0; a <= NUDOS; a++) {
    const [X, Y] = fn(x0 + (a / NUDOS) * w * res, y1 - (b / NUDOS) * h * res);
    gx[b * (NUDOS + 1) + a] = X;
    gy[b * (NUDOS + 1) + a] = Y;
  }
  return (i, j) => {
    const u = ((i + 0.5) / w) * NUDOS;
    const v = ((j + 0.5) / h) * NUDOS;
    const a = Math.min(NUDOS - 1, Math.floor(u));
    const b = Math.min(NUDOS - 1, Math.floor(v));
    const fu = u - a;
    const fv = v - b;
    const k = b * (NUDOS + 1) + a;
    const X = (gx[k] * (1 - fu) + gx[k + 1] * fu) * (1 - fv) + (gx[k + NUDOS + 1] * (1 - fu) + gx[k + NUDOS + 2] * fu) * fv;
    const Y = (gy[k] * (1 - fu) + gy[k + 1] * fu) * (1 - fv) + (gy[k + NUDOS + 1] * (1 - fu) + gy[k + NUDOS + 2] * fu) * fv;
    return [X, Y];
  };
}

// ----------------------------------------------------------------- formatos
function cerrar(an) {
  const a = an.map((p) => [Number(p[0]), Number(p[1])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (a.length && (a[0][0] !== a[a.length - 1][0] || a[0][1] !== a[a.length - 1][1])) a.push([a[0][0], a[0][1]]);
  return a;
}

/** Convierte una geometría GeoJSON (Polygon, MultiPolygon, Feature o colección) en multipolígono. */
export function deGeoJSON(obj) {
  if (!obj) return [];
  if (obj.type === "FeatureCollection") return obj.features.flatMap((f) => deGeoJSON(f));
  if (obj.type === "Feature") return deGeoJSON(obj.geometry);
  if (obj.type === "GeometryCollection") return obj.geometries.flatMap((g) => deGeoJSON(g));
  if (obj.type === "Polygon") return [obj.coordinates.map(cerrar)].filter((p) => p[0] && p[0].length >= 4);
  if (obj.type === "MultiPolygon") return obj.coordinates.map((p) => p.map(cerrar)).filter((p) => p[0] && p[0].length >= 4);
  return [];
}

export function aGeoJSON(geom) {
  return { type: "MultiPolygon", coordinates: geom };
}

/** Lee POLYGON o MULTIPOLYGON en WKT. */
export function deWkt(wkt) {
  const t = String(wkt || "").trim();
  const multi = /^MULTIPOLYGON/i.test(t);
  if (!multi && !/^POLYGON/i.test(t)) return [];
  const cuerpo = t.slice(t.indexOf("("));
  const poligonos = [];
  let nivel = 0;
  let inicio = -1;
  const objetivo = multi ? 2 : 1;
  for (let i = 0; i < cuerpo.length; i++) {
    if (cuerpo[i] === "(") {
      nivel++;
      if (nivel === objetivo) inicio = i;
    } else if (cuerpo[i] === ")") {
      if (nivel === objetivo && inicio >= 0) poligonos.push(cuerpo.slice(inicio, i + 1));
      nivel--;
    }
  }
  return poligonos
    .map((p) => (p.match(/\([^()]+\)/g) || []).map((an) => cerrar(an.slice(1, -1).split(",").map((par) => par.trim().split(/\s+/)))))
    .filter((p) => p[0] && p[0].length >= 4);
}

/** Lee los polígonos de un KML (texto). Coordenadas «lon,lat[,alt]» separadas por espacios. */
export function deKml(texto) {
  const geom = [];
  const rePol = /<Polygon[\s\S]*?<\/Polygon>/gi;
  const anillo = (bloque) => cerrar((bloque.match(/<coordinates>([\s\S]*?)<\/coordinates>/i) || ["", ""])[1].trim().split(/\s+/).map((c) => c.split(",")));
  for (const m of String(texto).match(rePol) || []) {
    const ext = m.match(/<outerBoundaryIs>[\s\S]*?<\/outerBoundaryIs>/i);
    if (!ext) continue;
    const pol = [anillo(ext[0])];
    for (const h of m.match(/<innerBoundaryIs>[\s\S]*?<\/innerBoundaryIs>/gi) || []) pol.push(anillo(h));
    if (pol[0].length >= 4) geom.push(pol);
  }
  return geom;
}

/** Comprueba que la geometría es utilizable y devuelve un texto de error o null. */
export function validar(geomLonLat) {
  if (!geomLonLat.length) return "sin_poligonos";
  for (const pol of geomLonLat) for (const an of pol) for (const [lon, lat] of an)
    if (!(lon >= -180 && lon <= 180 && lat >= -85 && lat <= 85)) return "fuera_de_rango";
  return null;
}

const TOLERANCIA_CRUCE = 1e-6; // en grados: unos 10 cm
function seCruzan(a, b, c, d) {
  // Lado del que queda r respecto a la recta p-q; 0 si está a menos de la tolerancia. Así
  // dos recintos vecinos que se tocan (un vértice de uno sobre el lado del otro) no cuentan
  // como cruzados por un redondeo de centímetros.
  const o = (p, q, r) => {
    const largo = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (!largo) return 0;
    const dist = ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / largo;
    return Math.abs(dist) < TOLERANCIA_CRUCE ? 0 : Math.sign(dist);
  };
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0; // cruce propio: tocarse no cuenta
}

/**
 * Comprobaciones extra para recintos dibujados o subidos por el usuario: un contorno que se
 * cruza consigo mismo o dos polígonos que se solapan darían superficies incoherentes.
 * Devuelve la clave del problema o null. Con geometrías muy grandes no se comprueba.
 */
export function validarRecinto(geomLonLat) {
  const basico = validar(geomLonLat);
  if (basico) return basico;
  const vertices = geomLonLat.reduce((n, pol) => n + pol.reduce((m, an) => m + an.length, 0), 0);
  if (vertices > 3000 || geomLonLat.length > 150) return null;
  for (const pol of geomLonLat) for (const an of pol) {
    const n = an.length - 1; // el último punto repite el primero
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // lados contiguos por el cierre
      if (seCruzan(an[i], an[i + 1], an[j], an[j + 1])) return "contorno_cruzado";
    }
  }
  for (let a = 0; a < geomLonLat.length; a++) for (let b = a + 1; b < geomLonLat.length; b++) {
    const A = geomLonLat[a], B = geomLonLat[b];
    const pa = puntoInterior([A]), pb = puntoInterior([B]);
    if (contiene([B], pa[0], pa[1]) || contiene([A], pb[0], pb[1])) return "recintos_solapados";
    const ea = A[0], eb = B[0];
    for (let i = 0; i + 1 < ea.length; i++) for (let j = 0; j + 1 < eb.length; j++)
      if (seCruzan(ea[i], ea[i + 1], eb[j], eb[j + 1])) return "recintos_solapados";
  }
  return null;
}

/**
 * Simplifica un multipolígono (Douglas-Peucker) con una tolerancia en las unidades de sus
 * coordenadas. Solo para dibujar: no se usa para medir.
 */
export function simplificar(geom, tolerancia) {
  const t2 = tolerancia * tolerancia;
  const anillo = (an) => {
    if (an.length <= 5) return an;
    const conservar = new Uint8Array(an.length);
    conservar[0] = conservar[an.length - 1] = 1;
    const pila = [[0, an.length - 1]];
    while (pila.length) {
      const [i0, i1] = pila.pop();
      const [x0, y0] = an[i0], [x1, y1] = an[i1];
      const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
      let peor = -1, dPeor = t2;
      for (let k = i0 + 1; k < i1; k++) {
        const u = l2 ? Math.max(0, Math.min(1, ((an[k][0] - x0) * dx + (an[k][1] - y0) * dy) / l2)) : 0;
        const d = (an[k][0] - x0 - u * dx) ** 2 + (an[k][1] - y0 - u * dy) ** 2;
        if (d > dPeor) { dPeor = d; peor = k; }
      }
      if (peor > 0) { conservar[peor] = 1; pila.push([i0, peor], [peor, i1]); }
    }
    const salida = an.filter((_, k) => conservar[k]);
    return salida.length >= 4 ? salida : an;
  };
  return geom.map((pol) => pol.map(anillo));
}

/** Datos básicos de una geometría en lon/lat: proyección local, superficie y centro. */
export function medir(geomLonLat) {
  const [lx0, ly0, lx1, ly1] = caja(geomLonLat);
  const local = proyeccionLocal((lx0 + lx1) / 2, (ly0 + ly1) / 2);
  const xy = transformar(geomLonLat, local.directa);
  const centroXY = puntoInterior(xy);
  return {
    local,
    xy,
    areaM2: superficie(xy),
    perimetroM: perimetro(xy),
    cajaLonLat: [lx0, ly0, lx1, ly1],
    cajaXY: caja(xy),
    centroLonLat: local.inversa(centroXY[0], centroXY[1]),
  };
}
