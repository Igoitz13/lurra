// Zonas inundables (España): cruce de la parcela con la cartografía oficial del SNCZI.
//
// Fuente: servicio WMTS «Peligrosidad por inundación fluvial y costera» del Sistema Nacional
// de Cartografía de Zonas Inundables (MITECO), publicado en la IDEE. Las teselas pintan la
// lámina de agua de cada periodo de retorno; aquí se leen sus píxeles y se cuenta cuántos caen
// dentro de la parcela. Con el nivel 17 cada píxel mide menos de un metro.

import { aMercator, mapeoRejilla, MEDIO_MUNDO, resolucionMercator } from "./geo.js";
import { enParalelo } from "./red.js";
import { CAPAS_TESELA, elegirZoom, leerTesela, teselasDeCaja } from "./teselas.js";
import { pct, porCelda } from "./contexto.js";

export const CAPAS = [
  { id: "fluvial_t10", capa: "NZ.Flood.FluvialT10", grupo: "fluvial", periodo: 10, nivel: "rojo" },
  { id: "fluvial_t100", capa: "NZ.Flood.FluvialT100", grupo: "fluvial", periodo: 100, nivel: "ambar" },
  { id: "fluvial_t500", capa: "NZ.Flood.FluvialT500", grupo: "fluvial", periodo: 500, nivel: "ambar" },
  { id: "marina_t100", capa: "NZ.Flood.MarinaT100", grupo: "marina", periodo: 100, nivel: "ambar" },
  { id: "marina_t500", capa: "NZ.Flood.MarinaT500", grupo: "marina", periodo: 500, nivel: "ambar" },
];
const ALFA_MIN = 32; // un píxel cuenta como lámina de agua si no es transparente
const ENTORNO_M = 100;
const Z_MAX = 17;

/**
 * Descarga las teselas de una capa. Devuelve {teselas: Map, fallos, total}.
 * El servicio contesta siempre con una imagen (transparente donde no hay lámina de agua):
 * cualquier otra respuesta es un fallo, nunca un «aquí no hay nada».
 */
async function cargar(capa, t, opciones) {
  const lista = [];
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) lista.push([x, y]);
  const teselas = new Map();
  let fallos = 0;
  await enParalelo(lista, 6, async ([x, y]) => {
    // Si las primeras teselas fallan todas, el servicio está caído: no se insiste con el resto.
    if (fallos >= 6 && teselas.size === 0) { fallos++; return; }
    try {
      const img = await leerTesela(CAPAS_TESELA.snczi(capa.capa)(t.z, x, y), { servicio: "SNCZI", estricto: true, espera: 15000, ...opciones });
      if (img && img.w > 0 && img.h > 0) teselas.set(`${x}/${y}`, img);
      else fallos++;
    } catch (e) {
      if (e.clave === "cancelado") throw e;
      fallos++;
    }
  });
  return { teselas, fallos, total: lista.length };
}

function hayAgua(teselas) {
  for (const img of teselas.values()) for (let k = 3; k < img.datos.length; k += 4) if (img.datos[k] > ALFA_MIN) return true;
  return false;
}

/**
 * Cuenta, celda a celda, la parte de la parcela que cae sobre píxeles pintados.
 * `sinDato` es el número de celdas de la parcela cuya tesela no se pudo leer.
 */
function medir(ctx, teselas, z, aPixel) {
  let n = 0, sinDato = 0;
  porCelda(ctx, (i, j) => {
    const [px, py] = aPixel(i, j);
    const tx = Math.floor(px / 256);
    const ty = Math.floor(py / 256);
    const img = teselas.get(`${tx}/${ty}`);
    if (!img) { sinDato++; return; }
    const u = Math.min(img.w - 1, Math.floor(((px - tx * 256) * img.w) / 256));
    const v = Math.min(img.h - 1, Math.floor(((py - ty * 256) * img.h) / 256));
    if (img.datos[(v * img.w + u) * 4 + 3] > ALFA_MIN) n++;
  });
  return { m2: n * ctx.m2PorCelda, sinDato };
}

/** ¿Hay lámina de agua dentro de la caja de píxeles globales [x0, y0, x1, y1]? */
function aguaEnCaja(teselas, [x0, y0, x1, y1]) {
  for (const [clave, img] of teselas) {
    const [tx, ty] = clave.split("/").map(Number);
    const ax = Math.max(0, Math.floor(x0 - tx * 256)), bx = Math.min(255, Math.ceil(x1 - tx * 256));
    const ay = Math.max(0, Math.floor(y0 - ty * 256)), by = Math.min(255, Math.ceil(y1 - ty * 256));
    const f = img.w / 256;
    for (let v = Math.floor(ay * f); v <= Math.min(img.h - 1, Math.floor(by * f)); v++)
      for (let u = Math.floor(ax * f); u <= Math.min(img.w - 1, Math.floor(bx * f)); u++)
        if (img.datos[(v * img.w + u) * 4 + 3] > ALFA_MIN) return true;
  }
  return false;
}

/**
 * Analiza la inundabilidad de la parcela. Devuelve una entrada por capa con la superficie
 * afectada. `estado` es "ok" o "error" (servicio caído: no equivale a «no inundable»).
 */
export async function analizar(ctx, opciones = {}) {
  const [lon0, lat0, lon1, lat1] = ctx.medida.cajaLonLat;
  const latMedia = (lat0 + lat1) / 2;
  const dLat = ENTORNO_M / 111320;
  const dLon = dLat / Math.cos((latMedia * Math.PI) / 180);
  const cajaEntorno = [lon0 - dLon, lat0 - dLat, lon1 + dLon, lat1 + dLat];
  const z = elegirZoom(cajaEntorno, Z_MAX, 16, 11);
  const t = teselasDeCaja(cajaEntorno, z);
  const res = resolucionMercator(z);
  const aPixel = (() => {
    const m = mapeoRejilla(ctx.rejilla, (x, y) => {
      const [lon, lat] = ctx.medida.local.inversa(x, y);
      return aMercator(lon, lat);
    });
    return (i, j) => {
      const [mx, my] = m(i, j);
      return [(mx + MEDIO_MUNDO) / res, (MEDIO_MUNDO - my) / res];
    };
  })();
  const [ex0, ey0] = aMercator(cajaEntorno[0], cajaEntorno[3]);
  const [ex1, ey1] = aMercator(cajaEntorno[2], cajaEntorno[1]);
  const cajaPx = [(ex0 + MEDIO_MUNDO) / res, (MEDIO_MUNDO - ey0) / res, (ex1 + MEDIO_MUNDO) / res, (MEDIO_MUNDO - ey1) / res];

  const salida = [];
  const porGrupo = {};
  let caido = false;
  // Se empieza por el periodo más largo: si a 500 y 100 años no hay nada cartografiado
  // alrededor, la capa de 10 años no hace falta descargarla.
  const orden = [...CAPAS].sort((a, b) => b.periodo - a.periodo);
  for (const capa of orden) {
    const g = (porGrupo[capa.grupo] ||= { consultadas: 0, conAgua: false });
    const saltar = g.consultadas >= (capa.grupo === "fluvial" ? 2 : 1) && !g.conAgua;
    let entrada;
    if (caido) {
      entrada = { estado: "error", m2: 0, enEntorno: false };
    } else if (saltar) {
      entrada = { estado: "ok", m2: 0, enEntorno: false, deducida: true };
    } else {
      const { teselas, fallos } = await cargar(capa, t, opciones);
      g.consultadas++;
      if (fallos > 0 && teselas.size === 0) caido = true; // ni una tesela: las demás capas tampoco se piden
      const agua = hayAgua(teselas);
      // Con alguna tesela sin leer no se deduce nada de las demás capas.
      if (agua || fallos > 0) g.conAgua = true;
      const medida = agua || fallos > 0 ? medir(ctx, teselas, z, aPixel) : { m2: 0, sinDato: 0 };
      if (medida.sinDato > 0) {
        // Falta el dato justo bajo la parcela: la capa no se da por consultada.
        entrada = { estado: "error", m2: 0, enEntorno: false };
      } else {
        // Si solo falta alguna tesela del entorno, la superficie dentro de la parcela es fiable;
        // lo que queda sin saber es si hay lámina de agua cerca (`incompleta`).
        entrada = { estado: "ok", m2: medida.m2, enEntorno: agua && (medida.m2 > 0 || aguaEnCaja(teselas, cajaPx)), incompleta: fallos > 0 };
      }
    }
    salida.push({ id: capa.id, grupo: capa.grupo, periodo: capa.periodo, nivel: capa.nivel, capaWmts: capa.capa, ...entrada, pct: pct(ctx, entrada.m2), afecta: entrada.m2 > 0 });
  }
  salida.sort((a, b) => CAPAS.findIndex((c) => c.id === a.id) - CAPAS.findIndex((c) => c.id === b.id));
  const cosLat = Math.cos((latMedia * Math.PI) / 180);
  return {
    estado: salida.every((c) => c.estado === "error") ? "error" : "ok",
    capas: salida,
    zoom: z,
    pixelM: res * cosLat,
    entornoM: ENTORNO_M,
  };
}
