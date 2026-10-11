// SIGPAC: recintos de la parcela, con su uso, pendiente y regadío.
//
// Servicio público de consultas del FEGA (comprobado el 11-10-2026, con CORS y cobertura de
// toda España, incluidos País Vasco, Navarra y Canarias):
//   - recinfobypoint: recinto que contiene un punto.
//   - recinfoparc:    todos los recintos de una parcela SIGPAC.

import { ErrorLurra, pedir } from "./red.js";
import { deGeoJSON, deWkt } from "./geo.js";
import { mascaraSolape, pct } from "./contexto.js";

const BASE = "https://sigpac-hubcloud.es/servicioconsultassigpac/query";
const CLAVES = ["provincia", "municipio", "agregado", "zona", "poligono", "parcela"];

export const USOS = {
  AG: ["Corrientes y superficies de agua", "Water bodies"],
  CA: ["Viales", "Roads and tracks"],
  CF: ["Asociación cítricos-frutales", "Citrus and fruit trees"],
  CI: ["Cítricos", "Citrus"],
  CS: ["Asociación cítricos-frutales de cáscara", "Citrus and nut trees"],
  CV: ["Asociación cítricos-viñedo", "Citrus and vineyard"],
  ED: ["Edificaciones", "Buildings"],
  EP: ["Elemento del paisaje", "Landscape feature"],
  FF: ["Asociación frutales-frutales de cáscara", "Fruit and nut trees"],
  FL: ["Frutos secos y olivar", "Nut trees and olive grove"],
  FO: ["Forestal", "Forest"],
  FS: ["Frutos secos", "Nut trees"],
  FV: ["Frutos secos y viñedo", "Nut trees and vineyard"],
  FY: ["Frutales", "Fruit trees"],
  IM: ["Improductivos", "Unproductive"],
  IV: ["Invernaderos y cultivos bajo plástico", "Greenhouses"],
  MT: ["Matorral", "Scrub"],
  OC: ["Asociación olivar-cítricos", "Olive grove and citrus"],
  OF: ["Olivar-frutal", "Olive grove and fruit trees"],
  OP: ["Otros cultivos permanentes", "Other permanent crops"],
  OV: ["Olivar", "Olive grove"],
  PA: ["Pasto con arbolado", "Wooded pasture"],
  PR: ["Pasto arbustivo", "Shrub pasture"],
  PS: ["Pastizal", "Grassland"],
  TA: ["Tierras arables", "Arable land"],
  TH: ["Huerta", "Vegetable garden"],
  VF: ["Viñedo-frutal", "Vineyard and fruit trees"],
  VI: ["Viñedo", "Vineyard"],
  VO: ["Viñedo-olivar", "Vineyard and olive grove"],
  ZC: ["Zona concentrada no incluida en la ortofoto", "Consolidated area not in the orthophoto"],
  ZU: ["Zona urbana", "Urban area"],
  ZV: ["Zona censurada", "Restricted area"],
};

export const PROVINCIAS = { 1: "Álava", 2: "Albacete", 3: "Alicante", 4: "Almería", 5: "Ávila", 6: "Badajoz", 7: "Illes Balears", 8: "Barcelona", 9: "Burgos", 10: "Cáceres", 11: "Cádiz", 12: "Castellón", 13: "Ciudad Real", 14: "Córdoba", 15: "A Coruña", 16: "Cuenca", 17: "Girona", 18: "Granada", 19: "Guadalajara", 20: "Gipuzkoa", 21: "Huelva", 22: "Huesca", 23: "Jaén", 24: "León", 25: "Lleida", 26: "La Rioja", 27: "Lugo", 28: "Madrid", 29: "Málaga", 30: "Murcia", 31: "Navarra", 32: "Ourense", 33: "Asturias", 34: "Palencia", 35: "Las Palmas", 36: "Pontevedra", 37: "Salamanca", 38: "Santa Cruz de Tenerife", 39: "Cantabria", 40: "Segovia", 41: "Sevilla", 42: "Soria", 43: "Tarragona", 44: "Teruel", 45: "Toledo", 46: "Valencia", 47: "Valladolid", 48: "Bizkaia", 49: "Zamora", 50: "Zaragoza", 51: "Ceuta", 52: "Melilla" };

function normalizar(p, geom) {
  return {
    clave: CLAVES.map((k) => p[k]).join("/") + "/" + p.recinto,
    codigos: Object.fromEntries(CLAVES.map((k) => [k, p[k]])),
    recinto: `${p.poligono}/${p.parcela}/${p.recinto}`,
    uso: p.uso_sigpac || null,
    superficieHa: p.superficie ?? null,
    pendientePct: p.pendiente_media ?? null,
    coefRegadio: p.coef_regadio ?? null,
    altitudM: p.altitud ?? null,
    geom,
  };
}

/** Recintos de la respuesta por punto (lista de objetos con WKT). */
export function leerPorPunto(datos) {
  const d = typeof datos === "string" ? JSON.parse(datos) : datos;
  return (Array.isArray(d) ? d : [d]).filter((r) => r && r.uso_sigpac).map((r) => normalizar(r, deWkt(r.wkt)));
}

/** Recintos de la respuesta por parcela (GeoJSON). */
export function leerPorParcela(datos) {
  const d = typeof datos === "string" ? JSON.parse(datos) : datos;
  return ((d && d.features) || []).filter((f) => f.properties && f.properties.uso_sigpac).map((f) => normalizar(f.properties, deGeoJSON(f.geometry)));
}

export async function recintosEnPunto(lon, lat, opciones = {}) {
  const url = `${BASE}/recinfobypoint/4326/${lon.toFixed(7)}/${lat.toFixed(7)}.json`;
  return leerPorPunto(await pedir(url, { como: "json", servicio: "SIGPAC", ...opciones }));
}

export async function recintosDeParcela(c, opciones = {}) {
  const url = `${BASE}/recinfoparc/${CLAVES.map((k) => c[k]).join("/")}.geojson`;
  return leerPorParcela(await pedir(url, { como: "json", servicio: "SIGPAC", ...opciones }));
}

/** Parcela SIGPAC que contiene un punto: la unión de sus recintos. Para el clic en el mapa. */
export async function parcelaEnPunto(lon, lat, opciones = {}) {
  const enPunto = await recintosEnPunto(lon, lat, opciones);
  if (!enPunto.length) throw new ErrorLurra("sigpac_sin_recinto");
  const c = enPunto[0].codigos;
  let recintos;
  try {
    recintos = await recintosDeParcela(c, opciones);
  } catch (e) {
    if (e.clave === "cancelado") throw e;
    recintos = enPunto;
  }
  if (!recintos.length) recintos = enPunto;
  return {
    id: `SIGPAC ${c.provincia}/${c.municipio}/${c.poligono}/${c.parcela}`,
    refcat: null,
    origen: "sigpac",
    geom: recintos.flatMap((r) => r.geom),
    areaCatastroM2: null,
    datos: { codigosSigpac: c, provincia: PROVINCIAS[c.provincia] || "", poligono: String(c.poligono), parcela: String(c.parcela) },
    recintosSigpac: recintos,
    rustica: true,
  };
}

const claveParcela = (c) => CLAVES.map((k) => c[k]).join("/");

/**
 * Recintos SIGPAC que tocan la parcela, con la superficie común.
 * Estrategia: recinto del punto interior → todos los recintos de esa parcela SIGPAC; mientras
 * quede parte de la finca sin cubrir, se pregunta por un punto de la zona que falta.
 * Devuelve {recintos, cubiertoPct}: `cubiertoPct` dice qué parte de la finca tiene recinto.
 */
export async function consultar(ctx, opciones = {}) {
  const vistos = new Map();
  const cubierta = new Uint8Array(ctx.mascara.length);
  let celdasCubiertas = 0;
  const anadir = (lista) => lista.forEach((r) => {
    if (!r.geom.length || vistos.has(r.clave)) return;
    const m = mascaraSolape(ctx, r.geom);
    let comunes = 0;
    for (let i = 0; i < m.length; i++) if (m[i]) { comunes++; if (!cubierta[i]) { cubierta[i] = 1; celdasCubiertas++; } }
    vistos.set(r.clave, { ...r, comunM2: comunes * ctx.m2PorCelda });
  });
  const anadirParcelaDe = async (recintos, parcelasVistas) => {
    const clave = recintos.length && claveParcela(recintos[0].codigos);
    if (!clave || parcelasVistas.has(clave)) return;
    parcelasVistas.add(clave);
    try {
      anadir(await recintosDeParcela(recintos[0].codigos, opciones));
    } catch (e) {
      if (e.clave === "cancelado") throw e;
    }
  };

  if (ctx.parcela.recintosSigpac) {
    anadir(ctx.parcela.recintosSigpac);
  } else {
    const parcelasVistas = new Set();
    const [lon, lat] = ctx.medida.centroLonLat;
    const primero = await recintosEnPunto(lon, lat, opciones);
    anadir(primero);
    await anadirParcelaDe(primero, parcelasVistas);

    // Lo que falte se busca preguntando por puntos de la zona sin cubrir. Cada punto probado
    // descarta su entorno, para no insistir donde SIGPAC no tiene recinto.
    const { w, h } = ctx.rejilla;
    const probada = new Uint8Array(ctx.mascara.length);
    const radio = Math.max(1, Math.round(Math.sqrt(ctx.celdas) / 12));
    let fallos = 0;
    for (let ronda = 0; ronda < 24 && celdasCubiertas < 0.97 * ctx.celdas; ronda++) {
      const libres = [];
      for (let k = 0; k < ctx.mascara.length; k++) if (ctx.mascara[k] && !cubierta[k] && !probada[k]) libres.push(k);
      if (libres.length < 0.01 * ctx.celdas) break;
      const k = libres[Math.floor(libres.length / 2)];
      const i = k % w, j = Math.floor(k / w);
      for (let b = Math.max(0, j - radio); b <= Math.min(h - 1, j + radio); b++)
        for (let a = Math.max(0, i - radio); a <= Math.min(w - 1, i + radio); a++) probada[b * w + a] = 1;
      const [plon, plat] = ctx.aLonLat(i, j);
      try {
        const mas = await recintosEnPunto(plon, plat, opciones);
        anadir(mas);
        await anadirParcelaDe(mas, parcelasVistas);
      } catch (e) {
        if (e.clave === "cancelado") throw e;
        if (++fallos >= 3) break;
      }
    }
  }
  const recintos = [];
  for (const r of vistos.values()) {
    if (r.comunM2 <= 0) continue;
    recintos.push({
      recinto: r.recinto,
      uso: r.uso,
      superficieHa: r.superficieHa,
      comunM2: r.comunM2,
      pct: pct(ctx, r.comunM2),
      pendientePct: r.pendientePct,
      coefRegadio: r.coefRegadio,
      altitudM: r.altitudM,
      geom: r.geom,
    });
  }
  recintos.sort((a, b) => b.comunM2 - a.comunM2);
  return { recintos, cubiertoPct: ctx.celdas ? Math.min(100, (100 * celdasCubiertas) / ctx.celdas) : 0 };
}
