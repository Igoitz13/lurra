// Mapa interactivo (Leaflet): elegir una parcela con un clic o dibujar un recinto.

import { CAPAS_TESELA } from "./teselas.js";

const plantilla = (fn) => fn("{z}", "{x}", "{y}");

export function crearMapa(el, { L, alClic, alDibujar, alCambiar }) {
  const mapa = L.map(el, { center: [40.2, -3.6], zoom: 6, zoomControl: true, attributionControl: true });
  const s2 = L.tileLayer(plantilla(CAPAS_TESELA.s2), { maxNativeZoom: 14, maxZoom: 20, attribution: "Sentinel-2 cloudless © EOX (Copernicus Sentinel 2016)" });
  const pnoa = L.tileLayer(plantilla(CAPAS_TESELA.pnoa), { maxNativeZoom: 19, maxZoom: 20, minZoom: 6, bounds: [[27.3, -18.5], [44.1, 4.7]], attribution: "PNOA © IGN España" });
  const osm = L.tileLayer(plantilla(CAPAS_TESELA.osm), { maxNativeZoom: 19, maxZoom: 20, attribution: "© OpenStreetMap" });
  const catastro = L.tileLayer.wms("https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx", {
    layers: "Catastro", format: "image/png", transparent: true, minZoom: 15, maxZoom: 20, opacity: 0.85, attribution: "D. G. del Catastro",
  });
  const orto = L.layerGroup([s2, pnoa]).addTo(mapa);
  catastro.addTo(mapa);
  const satelite = L.tileLayer(plantilla(CAPAS_TESELA.s2), { maxNativeZoom: 14, maxZoom: 20, attribution: "Sentinel-2 cloudless © EOX (Copernicus Sentinel 2016)" });
  const capas = { orto, satelite, mapa: osm, catastro };

  let modo = "clic";
  let vertices = [];
  let cerrado = false;
  const trazo = L.layerGroup().addTo(mapa);
  const seleccion = L.layerGroup().addTo(mapa);

  function pintarTrazo() {
    trazo.clearLayers();
    if (!vertices.length) return;
    const pts = vertices.map(([lon, lat]) => [lat, lon]);
    if (cerrado) L.polygon(pts, { color: "#14201b", weight: 3, fillColor: "#ffffff", fillOpacity: 0.2 }).addTo(trazo);
    else {
      L.polyline(pts, { color: "#14201b", weight: 3, dashArray: "6 6" }).addTo(trazo);
      pts.forEach((p, i) => {
        const m = L.circleMarker(p, { radius: i === 0 ? 8 : 5, color: "#14201b", weight: 2, fillColor: i === 0 ? "#2f6b4f" : "#ffffff", fillOpacity: 1, bubblingMouseEvents: false }).addTo(trazo);
        if (i === 0) m.on("click", () => terminar());
      });
    }
  }
  function cambio() {
    if (alCambiar) alCambiar({ modo, vertices: vertices.length, cerrado, zoom: mapa.getZoom() });
  }
  function terminar() {
    if (vertices.length < 3) return false;
    cerrado = true;
    pintarTrazo();
    cambio();
    if (alDibujar) alDibujar([[[...vertices, vertices[0]]]]);
    return true;
  }

  // Un doble clic acerca el mapa: no debe contar además como «elegir esta parcela». Por eso
  // el clic sencillo espera un instante por si llega el segundo.
  let relojClic = null;
  mapa.on("click", (ev) => {
    const { lng, lat } = ev.latlng.wrap(); // longitud siempre entre −180 y 180
    if (modo === "dibujo") {
      if (cerrado) return;
      const ultimo = vertices[vertices.length - 1];
      if (ultimo && Math.abs(ultimo[0] - lng) < 1e-7 && Math.abs(ultimo[1] - lat) < 1e-7) return; // doble clic en el mismo punto
      if (!vertices.length) seleccion.clearLayers(); // al empezar a dibujar se quita la parcela elegida antes
      vertices.push([lng, lat]);
      pintarTrazo();
      cambio();
    } else if (alClic) {
      clearTimeout(relojClic);
      relojClic = setTimeout(() => alClic(lng, lat, mapa.getZoom()), 280);
    }
  });
  mapa.on("dblclick", () => clearTimeout(relojClic));
  mapa.on("zoomend", cambio);

  return {
    mapa,
    ajustar: () => mapa.invalidateSize(),
    modo: (m) => {
      modo = m;
      clearTimeout(relojClic);
      // Dibujando, el doble clic no acerca el mapa: sería fácil moverlo sin querer.
      if (m === "dibujo") mapa.doubleClickZoom.disable(); else mapa.doubleClickZoom.enable();
      el.classList.toggle("mapa--dibujo", m === "dibujo");
      cambio();
    },
    capa: (nombre, visible) => {
      const c = capas[nombre];
      if (!c) return;
      if (nombre === "catastro") return void (visible ? c.addTo(mapa) : c.remove());
      capas.orto.remove(); capas.satelite.remove(); capas.mapa.remove();
      c.addTo(mapa);
      if (mapa.hasLayer(catastro)) catastro.bringToFront();
    },
    terminar,
    deshacer: () => {
      if (cerrado) cerrado = false;
      else vertices.pop();
      pintarTrazo();
      cambio();
    },
    borrar: () => {
      vertices = [];
      cerrado = false;
      trazo.clearLayers();
      seleccion.clearLayers();
      cambio();
    },
    /** Dibuja una geometría (multipolígono en lon/lat) y encuadra el mapa en ella. */
    mostrar: (geom, { encuadrar = true } = {}) => {
      seleccion.clearLayers();
      const capa = L.polygon(geom.map((pol) => pol.map((an) => an.map(([lon, lat]) => [lat, lon]))), { color: "#14201b", weight: 3, fillColor: "#ffffff", fillOpacity: 0.2 }).addTo(seleccion);
      if (encuadrar) mapa.fitBounds(capa.getBounds().pad(0.6), { maxZoom: 18 });
    },
    irA: (lat, lon, zoom = 15) => mapa.setView([lat, lon], zoom),
    encuadrar: ([s, n, o, e]) => mapa.fitBounds([[s, o], [n, e]], { maxZoom: 16 }),
  };
}

/** Busca un lugar por nombre (Nominatim, OpenStreetMap). Devuelve [{nombre, lat, lon, caja}]. */
export async function buscarLugar(texto, idioma = "es") {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=${idioma}&q=${encodeURIComponent(texto)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).map((x) => ({ nombre: x.display_name, lat: Number(x.lat), lon: Number(x.lon), caja: (x.boundingbox || []).map(Number) }));
}
