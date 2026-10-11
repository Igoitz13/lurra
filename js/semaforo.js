// Semáforo de atención: resume los hallazgos y propone qué preguntar.
//
// No es un veredicto. Verde significa «nada detectado en las capas consultadas»; no significa
// que la finca sirva para lo que el usuario quiere.

const ORDEN = { verde: 0, info: 0, ambar: 1, rojo: 2 };

/** `res` es el resultado del motor; `L` son las funciones de idioma de i18n.js. */
export function evaluar(res, L) {
  const { t } = L;
  const hallazgos = [];
  const sinConsultar = [];
  const preguntas = res.ambito === "es"
    ? [[t("sem.q.ayuntamiento"), t("sem.q.f1")], [t("sem.q.registro"), t("sem.q.f2")], [t("sem.q.vendedor"), t("sem.q.f3")], [t("sem.q.vendedor"), t("sem.q.f4")]]
    : [[t("sem.q.autoridad"), t("sem.q.m1")], [t("sem.q.registro_mundo"), t("sem.q.m2")], [t("sem.q.vendedor"), t("sem.q.f3")], [t("sem.q.vendedor"), t("sem.q.f4")]];

  // Lo que no se ha podido consultar nunca cuenta como «nada detectado».
  if (res.ambitoDudoso) sinConsultar.push(t("sem.ambito_dudoso"));
  if (res.inundacion && !Array.isArray(res.inundacion.capas)) sinConsultar.push(t("app.paso.inundacion"));
  const cruces = [...((res.inundacion && res.inundacion.capas) || []), ...(res.proteccion || [])];
  for (const c of cruces) {
    const nombre = t(`capa.${c.id}`);
    if (c.estado !== "ok") { sinConsultar.push(nombre); continue; }
    if (!c.afecta) continue;
    const marginal = c.pct < 1;
    const nombres = (c.elementos || []).slice(0, 3).map((e) => [e.codigo, e.nombre].filter(Boolean).join(" ")).filter(Boolean).join(", ");
    let detalle = marginal ? t("sem.h.borde", { m2: L.m2(c.m2) }) : t("sem.h.cruce", { pct: L.num(c.pct), m2: L.m2(c.m2) });
    if (nombres) detalle += `. ${nombres}`;
    if (marginal) detalle += `. ${t("sem.h.precision")}`;
    hallazgos.push({ nivel: marginal ? "ambar" : c.nivel, titulo: nombre, detalle });
    preguntas.push([t("sem.q.organismo"), t(`sem.q.${c.id}`)]);
  }

  const rel = res.relieve || {};
  if (rel.estado === "ok" && rel.pendienteMedia > 30) {
    hallazgos.push({ nivel: "ambar", titulo: t("sem.h.pendiente.t"), detalle: t("sem.h.pendiente.d", { pct: L.num(rel.pendienteMedia) }) });
  } else if (rel.estado === "error") {
    sinConsultar.push(t("app.paso.relieve"));
  }

  const eventos = (res.satelite && res.satelite.analisis && res.satelite.analisis.eventos) || [];
  for (const e of eventos) {
    if (e.recuperado) {
      hallazgos.push({ nivel: "info", titulo: t("sem.h.caida_rec.t"), detalle: t("sem.h.caida_rec.d", { inicio: L.mesAno(e.inicio), fin: L.mesAno(e.fin), recuperado: L.mesAno(e.recuperado) }) });
    } else {
      hallazgos.push({ nivel: "ambar", titulo: t("sem.h.caida.t"), detalle: t("sem.h.caida.d", { inicio: L.mesAno(e.inicio) }) });
      preguntas.push([t("sem.q.vendedor"), t("sem.q.caida", { fecha: L.mesAno(e.inicio) })]);
    }
  }

  let nivel = hallazgos.reduce((m, h) => (ORDEN[h.nivel] > ORDEN[m] ? h.nivel : m), "verde");
  if (nivel === "info") nivel = "verde";
  if (nivel === "verde" && sinConsultar.length) nivel = "incompleto";
  hallazgos.sort((a, b) => ORDEN[b.nivel] - ORDEN[a.nivel]);
  const aAclarar = hallazgos.filter((h) => h.nivel !== "info").length;
  let resumen = nivel === "incompleto" ? t("sem.resumen.incompleto", { capas: sinConsultar.join(", ") })
    : nivel === "verde" ? t("sem.resumen.verde") : t("sem.resumen.n", { n: aAclarar });
  // Con hallazgos y, además, capas sin consultar, el resumen también lo dice.
  if (nivel !== "incompleto" && sinConsultar.length) resumen += ` ${t("sem.resumen.faltan", { capas: sinConsultar.join(", ") })}`;
  return { nivel, etiqueta: t(`sem.${nivel}`), color: t(`sem.color.${nivel}`), resumen, hallazgos, preguntas, sinConsultar };
}
