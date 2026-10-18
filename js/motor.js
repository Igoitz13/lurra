// Motor del informe: recibe una parcela y devuelve todos los datos del informe.
// No depende del idioma ni de la página: se puede ejecutar también en Node.

import { crearContexto } from "./contexto.js";
import { validar, validarRecinto } from "./geo.js";
import { ErrorLurra } from "./red.js";
import * as catastro from "./catastro.js";
import * as sigpac from "./sigpac.js";
import * as inundacion from "./inundacion.js";
import * as proteccion from "./proteccion.js";
import * as relieve from "./relieve.js";
import * as cobertura from "./cobertura.js";
import * as satelite from "./satelite.js";
import * as urbanismo from "./urbanismo.js";
import * as mundo from "./mundo.js";

export const VERSION = 3;
export const AREA_MAX_M2 = 50000000; // 5.000 ha
export const AREA_MIN_M2 = 20;
export const AREA_MIN_SATELITE_M2 = 2000;
export const LADO_MAX_M = 60000;
export const RESOLUCION_SATELITE = 20;

/**
 * Megas que descarga la historia por satélite, como horquilla {min, max}. Medido con datos
 * reales (12-10-2026): unos 0,68 MB por mes en una finca que cae en una sola tesela de las
 * imágenes y 1,7 MB por mes si cae a caballo de dos; con cuatro sería aún más.
 */
export function megasSatelite(desde = "2017-01-01") {
  const meses = Math.max(1, Math.round((Date.now() - Date.parse(desde)) / (30.44 * 86400000)));
  const redondo = (v) => Math.round(v / 10) * 10;
  return { min: redondo(meses * 0.68), max: redondo(meses * 1.7) };
}

const enCajaEspana = ([lon, lat]) => (lon > -9.6 && lon < 4.6 && lat > 35.1 && lat < 43.95) || (lon > -18.4 && lon < -13.2 && lat > 27.4 && lat < 29.6);
const enCajaEuropa = ([lon, lat]) => lon > -31.5 && lon < 34.8 && lat > 34.4 && lat < 71.4;

/**
 * Decide qué fuentes se pueden usar: "es" (España), "ue" (resto de Europa) o "mundo".
 * Devuelve {ambito, dudoso}. `dudoso` avisa de que el recinto podría estar en España pero no
 * se ha podido comprobar (SIGPAC y Catastro no respondieron): el informe lo dice, porque
 * entonces faltan las zonas inundables y el SIGPAC.
 */
async function decidirAmbito(parcela, ctx, opciones) {
  if (parcela.origen === "catastro" || parcela.origen === "sigpac") return { ambito: "es", dudoso: false };
  const centro = ctx.medida.centroLonLat;
  let dudoso = false;
  if (enCajaEspana(centro)) {
    try {
      // SIGPAC solo tiene recintos en España: sirve para distinguirla de Portugal, Francia o Marruecos.
      const recintos = await sigpac.recintosEnPunto(centro[0], centro[1], opciones);
      if (recintos.length) return { ambito: "es", dudoso: false };
    } catch (e) {
      if (e.clave === "cancelado") throw e;
      // SIGPAC no responde: se pregunta al Catastro si en ese punto hay una parcela española.
      if (await catastro.refcatEnPunto(centro[0], centro[1], opciones)) return { ambito: "es", dudoso: false };
      dudoso = true;
    }
  }
  return { ambito: enCajaEuropa(centro) ? "ue" : "mundo", dudoso };
}

async function paso(nombre, alAvance, fn) {
  alAvance({ paso: nombre, estado: "en_curso" });
  try {
    const r = await fn();
    const todoFallo = Array.isArray(r) && r.length > 0 && r.every((x) => x.estado === "error");
    alAvance({ paso: nombre, estado: todoFallo || (r && r.estado === "error") ? "error" : "ok" });
    return r;
  } catch (e) {
    if (e instanceof ErrorLurra && e.clave === "cancelado") throw e;
    alAvance({ paso: nombre, estado: "error" });
    return { estado: "error", error: String((e && e.message) || e) };
  }
}

/**
 * Genera el informe (sin la historia por satélite, que se añade después con `historiaSatelite`).
 * `alAvance({paso, estado})` informa del progreso de cada apartado.
 */
export async function generarInforme(parcela, { alAvance = () => {}, senal = null, idioma = "es" } = {}) {
  const propio = parcela.origen === "dibujo" || parcela.origen === "fichero";
  const problema = propio ? validarRecinto(parcela.geom) : validar(parcela.geom);
  if (problema) throw new ErrorLurra(problema);
  const ctx = crearContexto(parcela);
  const area = ctx.medida.areaM2;
  if (!(area >= AREA_MIN_M2)) throw new ErrorLurra("muy_pequena", { areaM2: area });
  if (area > AREA_MAX_M2) throw new ErrorLurra("muy_grande", { areaM2: area, maxM2: AREA_MAX_M2 });
  // Partes muy separadas: la rejilla común sería demasiado gruesa para medir nada con ellas.
  const [cx0, cy0, cx1, cy1] = ctx.medida.cajaXY;
  const partesLejanas = parcela.geom.length > 1 && ctx.rejilla.res > 0.75 && ctx.celdas < 200;
  if (Math.max(cx1 - cx0, cy1 - cy0) > LADO_MAX_M) throw new ErrorLurra(parcela.geom.length > 1 ? "muy_disperso" : "muy_largo", { km: LADO_MAX_M / 1000 });
  if (partesLejanas) throw new ErrorLurra("muy_disperso");
  const opciones = { senal };
  const { ambito, dudoso } = await decidirAmbito(parcela, ctx, opciones);
  alAvance({ paso: "parcela", estado: "ok" });

  const tareas = {
    relieve: paso("relieve", alAvance, () => relieve.analizar(ctx, ambito, opciones)),
    proteccion: paso("proteccion", alAvance, () => proteccion.analizar(ctx, ambito, opciones)),
    // España: cartografía oficial del SNCZI. Resto del mundo: modelo mundial de GloFAS, salvo
    // que no se sepa si el recinto está en España (entonces no se da por buena una respuesta peor).
    inundacion: ambito === "es" ? paso("inundacion", alAvance, () => inundacion.analizar(ctx, opciones))
      : dudoso ? null : paso("inundacion", alAvance, () => mundo.inundacion(ctx, opciones)),
    sigpac: ambito === "es" ? paso("sigpac", alAvance, async () => {
      const r = await sigpac.consultar(ctx, opciones);
      return { estado: "ok", recintos: r.recintos.map(({ geom, ...resto }) => resto), cubiertoPct: r.cubiertoPct };
    }) : null,
    // Clasificación urbanística orientativa del Sistema de Información Urbana (solo España).
    urbanismo: ambito === "es" ? paso("urbanismo", alAvance, () => urbanismo.analizar(ctx, opciones)) : null,
    cobertura: ambito !== "es" ? paso("cobertura", alAvance, () => cobertura.analizar(ctx, opciones)) : null,
    // Fuera de España el recinto no trae municipio: se pregunta por el nombre del lugar.
    lugar: ambito !== "es" ? mundo.lugar(ctx.medida.centroLonLat, idioma, opciones) : null,
  };
  const [rel, prot, inun, sig, urb, cob, lugar] = await Promise.all(Object.values(tareas));

  const { geom, recintosSigpac, ...resto } = parcela;
  return {
    version: VERSION,
    generado: new Date().toISOString(),
    ambito,
    ...(dudoso ? { ambitoDudoso: true } : {}),
    parcela: {
      ...resto,
      geom,
      areaM2: area,
      perimetroM: ctx.medida.perimetroM,
      centro: ctx.medida.centroLonLat,
      caja: ctx.medida.cajaLonLat,
      ...(lugar ? { lugar } : {}),
    },
    relieve: rel,
    // Si la capa de protección entera falla, se anota como una entrada con error por capa.
    proteccion: Array.isArray(prot) ? prot : prot ? proteccion.capasDe(ambito).map((id) => ({ id, nivel: "ambar", estado: "error", afecta: false, m2: 0, pct: 0, elementos: [] })) : null,
    inundacion: inun,
    sigpac: sig,
    urbanismo: urb,
    cobertura: cob,
    satelite: { estado: area < AREA_MIN_SATELITE_M2 ? "pequena" : "pendiente", minimoM2: AREA_MIN_SATELITE_M2 },
  };
}

/**
 * Historia por satélite de un informe ya generado. Devuelve el objeto `satelite` del informe.
 * `alAvance({hechas, total, satelite})` permite pintar la serie mientras se lee.
 */
export async function historiaSatelite(res, { desde = "2017-01-01", alAvance = null, senal = null } = {}) {
  if (res.parcela.areaM2 < AREA_MIN_SATELITE_M2) return { estado: "pequena", minimoM2: AREA_MIN_SATELITE_M2 };
  const componer = (serie, extra = {}) => ({ estado: "ok", serie, analisis: satelite.analizar(serie), resolucion: RESOLUCION_SATELITE, desde, ...extra });
  let ultimo = { hechas: 0, total: 0, serie: [] };
  try {
    const r = await satelite.serieNdvi(res.parcela.geom, res.parcela.centro, {
      desde, resolucion: RESOLUCION_SATELITE, senal,
      alAvance: (a) => {
        ultimo = a;
        if (alAvance) alAvance({ hechas: a.hechas, total: a.total, satelite: componer(a.serie, { leyendo: { hechas: a.hechas, total: a.total } }) });
      },
    });
    // Ningún mes con imagen limpia (finca siempre nublada o fuera de las imágenes): no hay serie.
    if (!r.serie.length) return { estado: "vacia", meses: r.meses, fallos: r.fallos };
    return componer(r.serie, { meses: r.meses, fallos: r.fallos });
  } catch (e) {
    if (e instanceof ErrorLurra && e.clave === "cancelado") {
      // Se conserva lo leído hasta el momento.
      return ultimo.serie.length ? componer(ultimo.serie, { parcial: { hechas: ultimo.hechas, total: ultimo.total } }) : { estado: "omitido" };
    }
    return { estado: "error", error: String((e && e.message) || e) };
  }
}
