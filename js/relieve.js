// Relieve: altitud, pendiente y orientación de la parcela.
//
// España: Modelo Digital del Terreno de 5 m del IGN, servicio WCS INSPIRE (CC-BY 4.0).
// Resto del mundo (y reserva si el IGN falla): teselas «terrarium» de Mapzen/AWS, que
// combinan fuentes abiertas (unos 30 m de detalle real fuera de las zonas con LiDAR).

import { aMercator, mapeoRejilla, MEDIO_MUNDO, resolucionMercator, utm } from "./geo.js";
import { enParalelo, ErrorLurra, pedir } from "./red.js";
import { CAPAS_TESELA, elegirZoom, leerTesela, teselasDeCaja } from "./teselas.js";
import { porCelda } from "./contexto.js";

const WCS = "https://servicios.idee.es/wcs-inspire/mdt";
export const ORIENTACIONES = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];

/** Lee una malla en formato ASCII de Esri (la respuesta del WCS viene envuelta en MIME). */
export function leerAsc(texto) {
  const ini = texto.search(/ncols/i);
  if (ini < 0) throw new Error("La respuesta no es una malla ASCII");
  const fin = texto.indexOf("\n--", ini);
  const partes = (fin > 0 ? texto.slice(ini, fin) : texto.slice(ini)).trim().split(/\s+/);
  const cab = {};
  let k = 0;
  while (k + 1 < partes.length && /^[a-z_]+$/i.test(partes[k])) {
    cab[partes[k].toLowerCase()] = Number(partes[k + 1]);
    k += 2;
  }
  const w = cab.ncols, h = cab.nrows, paso = cab.cellsize;
  if (!(w > 0 && h > 0 && paso > 0)) throw new Error("Cabecera de malla incompleta");
  const nodata = cab.nodata_value ?? -9999;
  const z = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const v = Number(partes[k + i]);
    z[i] = Number.isFinite(v) && v !== nodata && v > -1000 ? v : NaN;
  }
  const x0 = cab.xllcorner ?? cab.xllcenter - paso / 2;
  const yInf = cab.yllcorner ?? cab.yllcenter - paso / 2;
  return { w, h, x0, y1: yInf + h * paso, px: paso, py: paso, z };
}

/** Pendiente (%) y orientación (grados desde el norte, ladera abajo) con el método de Horn. */
export function pendienteOrientacion(z, w, h, dx, dy) {
  const pend = new Float32Array(w * h).fill(NaN);
  const orient = new Float32Array(w * h).fill(NaN);
  const v = (c, f) => z[Math.max(0, Math.min(h - 1, f)) * w + Math.max(0, Math.min(w - 1, c))];
  for (let f = 0; f < h; f++) for (let c = 0; c < w; c++) {
    const a = v(c - 1, f - 1), b = v(c, f - 1), cc = v(c + 1, f - 1);
    const d = v(c - 1, f), e = v(c + 1, f);
    const g = v(c - 1, f + 1), hh = v(c, f + 1), i = v(c + 1, f + 1);
    const dzdx = (cc + 2 * e + i - (a + 2 * d + g)) / (8 * dx);
    const dzdySur = (g + 2 * hh + i - (a + 2 * b + cc)) / (8 * dy);
    if (!Number.isFinite(dzdx) || !Number.isFinite(dzdySur)) continue;
    pend[f * w + c] = 100 * Math.hypot(dzdx, dzdySur);
    orient[f * w + c] = ((Math.atan2(-dzdx, dzdySur) * 180) / Math.PI + 360) % 360;
  }
  return { pend, orient };
}

/** Resume un MDT (en cualquier proyección) dentro de la parcela. */
export function resumir(ctx, mdt) {
  const { pend, orient } = pendienteOrientacion(mdt.z, mdt.w, mdt.h, mdt.px * mdt.escala, mdt.py * mdt.escala);
  const aMdt = mapeoRejilla(ctx.rejilla, (x, y) => {
    const [lon, lat] = ctx.medida.local.inversa(x, y);
    return mdt.directa(lon, lat);
  });
  let n = 0, sz = 0, zMin = Infinity, zMax = -Infinity, sp = 0, pMax = 0, mas20 = 0;
  const sectores = new Array(8).fill(0);
  porCelda(ctx, (i, j) => {
    const [X, Y] = aMdt(i, j);
    const c = Math.floor((X - mdt.x0) / mdt.px);
    const f = Math.floor((mdt.y1 - Y) / mdt.py);
    if (c < 0 || c >= mdt.w || f < 0 || f >= mdt.h) return;
    const k = f * mdt.w + c;
    const zz = mdt.z[k], p = pend[k];
    if (!Number.isFinite(zz) || !Number.isFinite(p)) return;
    n++;
    sz += zz;
    if (zz < zMin) zMin = zz;
    if (zz > zMax) zMax = zz;
    sp += p;
    if (p > pMax) pMax = p;
    if (p > 20) mas20++;
    // Las celdas llanas no tienen orientación (y la fórmula las mandaría al norte).
    if (p >= 2) sectores[Math.floor((orient[k] + 22.5) / 45) % 8]++;
  });
  if (!n) throw new ErrorLurra("relieve_sin_datos");
  const media = sp / n;
  const pasoM = mdt.px * mdt.escala;
  return {
    estado: "ok",
    fuente: mdt.fuente,
    pasoM,
    altitudMin: zMin,
    altitudMedia: sz / n,
    altitudMax: zMax,
    pendienteMedia: media,
    pendienteMax: pMax,
    pctMas20: (100 * mas20) / n,
    orientacion: media < 3 || !sectores.some((v) => v > 0) ? null : ORIENTACIONES[sectores.indexOf(Math.max(...sectores))],
    // Con un modelo de unos 30 m de detalle, en fincas pequeñas la pendiente es orientativa.
    aproximado: (mdt.fuente === "terrarium" || pasoM >= 20) && ctx.medida.areaM2 < 20000,
  };
}

/** MDT del IGN para la caja de la parcela (península y Baleares en UTM 30; Canarias en UTM 28). */
export async function mdtIgn(ctx, opciones = {}) {
  const [lon0, lat0, lon1, lat1] = ctx.medida.cajaLonLat;
  const canarias = (lon0 + lon1) / 2 < -12;
  const proy = utm(canarias ? 28 : 30);
  const esquinas = [[lon0, lat0], [lon0, lat1], [lon1, lat0], [lon1, lat1], [(lon0 + lon1) / 2, lat0], [(lon0 + lon1) / 2, lat1]].map(([a, b]) => proy.directa(a, b));
  const xs = esquinas.map((p) => p[0]), ys = esquinas.map((p) => p[1]);
  const lado = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const paso = lado > 15000 ? 200 : lado > 3000 ? 25 : 5;
  const m = 4 * paso;
  const red = (v, f) => f(v / paso) * paso;
  const x0 = red(Math.min(...xs) - m, Math.floor), x1 = red(Math.max(...xs) + m, Math.ceil);
  const y0 = red(Math.min(...ys) - m, Math.floor), y1 = red(Math.max(...ys) + m, Math.ceil);
  const cobertura = `Elevacion${canarias ? 4083 : 25830}_${paso}`;
  const url = `${WCS}?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=${cobertura}&SUBSET=x(${x0},${x1})&SUBSET=y(${y0},${y1})&FORMAT=application/asc`;
  const malla = await pedir(url, { servicio: "IGN (MDT)", espera: 45000, leer: leerAsc, ...opciones });
  return { ...malla, escala: 1, directa: proy.directa, fuente: `ign${paso}` };
}

/** MDT global a partir de teselas «terrarium». */
export async function mdtTerrarium(ctx, opciones = {}) {
  const [lon0, lat0, lon1, lat1] = ctx.medida.cajaLonLat;
  const latMedia = (lat0 + lat1) / 2;
  const cos = Math.cos((latMedia * Math.PI) / 180);
  const dLat = 60 / 111320, dLon = dLat / cos;
  const caja = [lon0 - dLon, lat0 - dLat, lon1 + dLon, lat1 + dLat];
  const z = elegirZoom(caja, 14, 9, 8);
  const t = teselasDeCaja(caja, z);
  const nx = t.x1 - t.x0 + 1, ny = t.y1 - t.y0 + 1;
  const w = nx * 256, h = ny * 256;
  const alt = new Float32Array(w * h).fill(NaN);
  const lista = [];
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) lista.push([x, y]);
  let leidas = 0;
  await enParalelo(lista, 6, async ([x, y]) => {
    const img = await leerTesela(CAPAS_TESELA.terrarium(z, x, y), { servicio: "Terrain Tiles", ...opciones });
    if (!img || img.w !== 256) return;
    leidas++;
    const ox = (x - t.x0) * 256, oy = (y - t.y0) * 256;
    for (let v = 0; v < 256; v++) for (let u = 0; u < 256; u++) {
      const k = (v * 256 + u) * 4;
      alt[(oy + v) * w + ox + u] = img.datos[k] * 256 + img.datos[k + 1] + img.datos[k + 2] / 256 - 32768;
    }
  });
  if (!leidas) throw new ErrorLurra("servicio", { servicio: "Terrain Tiles" });
  const res = resolucionMercator(z);
  return {
    w, h, z: alt,
    x0: t.x0 * 256 * res - MEDIO_MUNDO,
    y1: MEDIO_MUNDO - t.y0 * 256 * res,
    px: res, py: res,
    escala: cos, // metros reales por metro Mercator
    directa: aMercator,
    fuente: "terrarium",
  };
}

export async function analizar(ctx, ambito, opciones = {}) {
  if (ambito === "es") {
    try {
      return resumir(ctx, await mdtIgn(ctx, opciones));
    } catch (e) {
      if (e.clave === "cancelado") throw e;
      // Si el IGN no responde se sigue con el modelo global, y el informe lo dice.
    }
  }
  return resumir(ctx, await mdtTerrarium(ctx, opciones));
}
