/*
 * Atlante della campagna: mappa in stile "maps", solo consultazione.
 *
 * Viste (nell'URL, così il tasto Indietro funziona):
 *   #/                     mappa regionale con i luoghi
 *   #/luogo/<id>           mappa interna del luogo con i punti d'interesse (POI);
 *                          se il luogo non ha una mappa, zoom sulla mappa regionale
 *   #/luogo/<id>/<n>       come sopra, centrata sul POI n (da 0)
 *
 * Zoom a due livelli: ogni mappa (regione, città) ha i suoi tile e il suo zoom.
 * Entrando in una città si vola sul luogo nella mappa regionale, poi una breve
 * dissolvenza sostituisce i tile con quelli della città; uscendo si fa il contrario.
 *
 * Coordinate: nei dati sono pixel dell'immagine originale [x, y]; Leaflet
 * (CRS.Simple) le converte con project/unproject allo zoom massimo della mappa.
 *
 * Vista giocatori (<html data-vista="giocatori">): è la copia pubblica generata da
 * strumenti/pubblica_mappa.py, con i dati già ripuliti dai segreti. Qui nasconde
 * la modalità editor e gli avvisi tecnici per il Master.
 */
"use strict";

const VISTA_GIOCATORI = document.documentElement.dataset.vista === "giocatori";
const ZOOM_EXTRA = 1; // un livello oltre la risoluzione originale (tile ingranditi 2x)
const ATTRIBUZIONE = VISTA_GIOCATORI
  ? "Mappe © Wizards of the Coast"
  : "Mappe © Wizards of the Coast – solo uso personale";

const ICONE_TIPO = {
  metropoli: "corona",
  città: "torre",
  cittadina: "casa",
  villaggio: "casa",
  fortezza: "scudo",
  rovina: "rovina",
  regione: "monti",
};

// Stato della mappa interna di un luogo
const STATI = {
  pronta: { chip: "Mappa", piede: "Ha una mappa interna: clic per entrare", legenda: "Con mappa interna: clic per entrare" },
  "da-scaricare": { chip: "Da scaricare", piede: "Mappa prevista, non ancora scaricata", legenda: "Mappa prevista, da scaricare" },
  assente: { chip: "", piede: "Nessuna mappa interna: clic per avvicinarsi", legenda: "Solo sulla mappa regionale" },
};

const el = {
  indietro: document.getElementById("indietro"),
  indietroTesto: document.getElementById("indietro-testo"),
  titolo: document.getElementById("titolo"),
  sottotitolo: document.getElementById("sottotitolo"),
  descrizione: document.getElementById("descrizione"),
  avviso: document.getElementById("avviso"),
  cerca: document.getElementById("cerca"),
  intestazione: document.getElementById("intestazione-elenco"),
  elenco: document.getElementById("elenco"),
  legenda: document.getElementById("legenda"),
  livello: document.getElementById("livello"),
  velo: document.getElementById("velo"),
  mappa: document.getElementById("mappa"),
  zoom: document.getElementById("controlli-zoom"),
  strumenti: document.getElementById("controlli-editor"),
  editor: document.getElementById("editor"),
  cursore: document.getElementById("cursore"),
  vedute: document.getElementById("vedute"),
  lightbox: document.getElementById("lightbox"),
  lightboxImmagine: document.getElementById("lightbox-immagine"),
  lightboxTitolo: document.getElementById("lightbox-titolo"),
  lightboxNota: document.getElementById("lightbox-nota"),
};

const mappa = L.map("mappa", {
  crs: L.CRS.Simple,
  zoomControl: false,
  zoomSnap: 0.25,
  zoomDelta: 0.5,
  wheelPxPerZoomLevel: 90,
  maxBoundsViscosity: 0.8,
});
mappa.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
mappa.attributionControl.addAttribution(ATTRIBUZIONE);

const stato = {
  dati: null,
  info: new Map(),      // id mappa -> info.json (null se mancano i tile)
  mappaCorrente: null,  // id della mappa mostrata
  zoomMax: 0,
  zoomIntero: 0,        // zoom che inquadra tutta la mappa mostrata
  limiti: null,         // limiti della mappa mostrata
  livelloTile: null,
  strato: L.layerGroup().addTo(mappa),
  voci: [],             // voci dell'elenco: { li, testo, extra }
  percorso: null,       // vista precedente, per le transizioni
  editor: false,
  richiesta: 0,         // evita che una vista lenta sovrascriva quella successiva
};

const riduciMovimento = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Utilità ----------

const escape = (testo = "") =>
  String(testo).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Minuscolo e senza accenti, per la ricerca
const normalizza = (testo = "") => testo.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const icona = (nome) => `<svg class="icona" aria-hidden="true"><use href="#i-${nome}"/></svg>`;

const iconaTipo = (tipo) => icona(ICONE_TIPO[tipo] ?? "torre");

const pausa = (ms) => new Promise((risolvi) => setTimeout(risolvi, ms));

const aLatLng = ([x, y]) => mappa.unproject([x, y], stato.zoomMax);

/**
 * Zoom "vicino" per le transizioni: delta livelli oltre la vista d'insieme,
 * senza superare lo zoom massimo. Così le animazioni non dipendono dalla
 * risoluzione dell'immagine.
 */
const zoomVicino = (delta) => Math.min(stato.zoomIntero + delta, mappa.getMaxZoom());

const aPixel = (latlng) => {
  const p = mappa.project(latlng, stato.zoomMax);
  return [Math.round(p.x), Math.round(p.y)];
};

const haPosizione = (poi) => Array.isArray(poi.coord) && poi.coord.length === 2;

function statoMappa(luogo) {
  if (!luogo.mappa) return "assente";
  return stato.info.get(luogo.mappa) ? "pronta" : "da-scaricare";
}

/** Cerchio con l'icona del tipo; se il luogo ha una mappa interna, distintivo rosso. */
function gettone(tipo, statoLuogo) {
  const distintivo = statoLuogo === "pronta" ? `<span class="distintivo">${icona("mappa")}</span>` : "";
  return `<span class="gettone stato-${statoLuogo}">${iconaTipo(tipo)}${distintivo}</span>`;
}

function chip(statoLuogo) {
  const testo = STATI[statoLuogo].chip;
  if (!testo) return "";
  const simbolo = statoLuogo === "pronta" ? icona("mappa") : "";
  return `<span class="chip chip-${statoLuogo}">${simbolo}${escape(testo)}</span>`;
}

function mostraAvviso(html) {
  el.avviso.innerHTML = html;
  el.avviso.hidden = !html;
}

/** Avvisi su script e dati da sistemare: solo nella vista del Master. */
const avvisoMaster = (html) => mostraAvviso(VISTA_GIOCATORI ? "" : html);

/** Legge tile/indice.json (scritto da genera_tile.py): quali mappe hanno i tile pronti. */
async function caricaIndice() {
  try {
    const risposta = await fetch("tile/indice.json", { cache: "no-cache" });
    if (!risposta.ok) return;
    for (const [id, info] of Object.entries(await risposta.json())) stato.info.set(id, info);
  } catch {
    // Nessun tile generato: ogni vista mostrerà come scaricare le mappe
  }
}

// ---------- Animazioni ----------

async function vola(latlng, zoom, durata = 0.9) {
  if (riduciMovimento) {
    mappa.setView(latlng, zoom, { animate: false });
    return;
  }
  const fine = new Promise((risolvi) => mappa.once("moveend", risolvi));
  mappa.flyTo(latlng, zoom, { duration: durata });
  await Promise.race([fine, pausa(durata * 1000 + 400)]);
}

async function velo(attivo) {
  const cambia = el.velo.classList.contains("attivo") !== attivo;
  el.velo.classList.toggle("attivo", attivo);
  if (cambia && !riduciMovimento) await pausa(260);
}

// ---------- Mappa di sfondo ----------

/** Mostra i tile della mappa idMappa (se non è già quella visibile) e ne ritorna i limiti. */
function mostraMappa(idMappa, info) {
  const limiti = L.latLngBounds(
    mappa.unproject([0, info.altezza], info.zoomMax),
    mappa.unproject([info.larghezza, 0], info.zoomMax),
  );
  if (stato.mappaCorrente === idMappa) return limiti;

  if (stato.livelloTile) stato.livelloTile.remove();
  stato.zoomMax = info.zoomMax;
  stato.mappaCorrente = idMappa;
  stato.limiti = limiti;
  stato.strato.clearLayers();

  // I limiti di zoom si impostano direttamente nelle opzioni: setMinZoom/setMaxZoom
  // farebbero partire uno zoom animato dalla vista della mappa precedente, che
  // finirebbe dopo il fitBounds e lo annullerebbe.
  mappa.setMaxBounds(null);
  mappa.options.minZoom = -5;
  mappa.options.maxZoom = info.zoomMax + ZOOM_EXTRA;
  const zoomIntero = mappa.getBoundsZoom(limiti, false);
  stato.zoomIntero = zoomIntero;
  mappa.fitBounds(limiti, { animate: false });
  mappa.options.minZoom = zoomIntero - 0.25; // si rimpicciolisce fino a vedere tutta la mappa
  mappa.setMaxBounds(limiti.pad(0.1));
  mappa.fire("zoomlevelschange");

  stato.livelloTile = L.tileLayer(`tile/${encodeURIComponent(idMappa)}/{z}/{x}/{y}.jpg`, {
    tileSize: info.lato,
    minNativeZoom: 0,
    maxNativeZoom: info.zoomMax,
    maxZoom: info.zoomMax + ZOOM_EXTRA,
    minZoom: -5,
    bounds: limiti,
    noWrap: true,
  }).addTo(mappa);
  return limiti;
}

// ---------- Marker ----------

function creaMarker(coord, { classe, html, dimensione, ancora, tooltip, etichetta, alClic }) {
  const marker = L.marker(aLatLng(coord), {
    icon: L.divIcon({
      className: classe,
      html,
      iconSize: dimensione,
      iconAnchor: ancora,
      tooltipAnchor: [0, -ancora[1]],
    }),
    keyboard: true,
    riseOnHover: true,
  });
  marker.bindTooltip(tooltip, { direction: "top", offset: [0, -6], className: "scheda" });
  marker.on("click", () => (stato.editor ? copiaCoordinate(coord, marker.getLatLng()) : alClic()));
  marker.on("add", () => {
    const elemento = marker.getElement();
    elemento.setAttribute("role", "button");
    elemento.setAttribute("aria-label", etichetta);
    elemento.addEventListener("keydown", (evento) => {
      if (evento.key === "Enter" || evento.key === " ") {
        evento.preventDefault();
        marker.fire("click");
      }
    });
  });
  marker.addTo(stato.strato);
  return marker;
}

function schedaLuogo(luogo) {
  const s = statoMappa(luogo);
  return `<div class="scheda-testa">${gettone(luogo.tipo, s)}` +
    `<strong>${escape(luogo.nome)}</strong><span class="tipo">${escape(luogo.tipo)}</span></div>` +
    `<p>${escape(luogo.descrizione)}</p>` +
    `<div class="scheda-piede stato-${s}">${icona(s === "pronta" ? "mappa" : "spillo")}${escape(STATI[s].piede)}</div>`;
}

function schedaPoi(poi, numero) {
  const segreto = poi.segreto ? " segreto" : "";
  return `<div class="scheda-testa"><span class="numero${segreto}">${numero}</span>` +
    `<strong>${escape(poi.nome)}</strong></div>` +
    (poi.descrizione ? `<p>${escape(poi.descrizione)}</p>` : "") +
    (poi.segreto ? `<div class="scheda-piede stato-assente">Segreto: solo per il Master</div>` : "");
}

/** Marker di tutti i luoghi sulla mappa regionale. Ritorna id -> marker. */
function disegnaLuoghi(idEvidenziato = null) {
  stato.strato.clearLayers();
  const marker = new Map();
  for (const luogo of stato.dati.luoghi) {
    if (!haPosizione(luogo)) continue; // solo nell'elenco, finché non ha coordinate
    const s = statoMappa(luogo);
    const lato = s === "pronta" ? 34 : 24;
    const m = creaMarker(luogo.coord, {
      classe: `marker-luogo${luogo.id === idEvidenziato ? " evidenziato" : ""}`,
      html: gettone(luogo.tipo, s),
      dimensione: [lato, lato],
      ancora: [lato / 2, lato / 2],
      tooltip: schedaLuogo(luogo),
      etichetta: `${luogo.nome}${s === "pronta" ? ", con mappa interna" : ""}`,
      alClic: () => (location.hash = `#/luogo/${encodeURIComponent(luogo.id)}`),
    });
    marker.set(luogo.id, m);
  }
  return marker;
}

// ---------- Pannello ----------

function impostaPannello({ titolo, sottotitolo = "", descrizione = "", indietro = null, intestazione = "", vedute = [] }) {
  el.titolo.textContent = titolo;
  el.sottotitolo.innerHTML = sottotitolo;
  el.descrizione.textContent = descrizione;
  mostraVedute(vedute);
  el.indietro.hidden = !indietro;
  if (indietro) el.indietroTesto.textContent = indietro;
  el.intestazione.textContent = intestazione;
  el.elenco.replaceChildren();
  stato.voci = [];
}

function aggiungiVoce({ inizio, nome, dettaglio, fine = "", classe = "", marker = null, alClic, testoRicerca }) {
  const li = document.createElement("li");
  li.className = classe;
  const bottone = document.createElement("button");
  bottone.type = "button";
  bottone.innerHTML = `${inizio}<span class="testo"><span class="nome">${escape(nome)}</span>` +
    (dettaglio ? `<span class="dettaglio">${escape(dettaglio)}</span>` : "") + `</span>${fine}`;
  bottone.addEventListener("click", alClic);
  if (marker) {
    // Passando sull'elenco si evidenzia il marker, e viceversa
    const accendi = (acceso) => {
      marker.getElement()?.classList.toggle("evidenziato", acceso);
      if (acceso) marker.openTooltip();
      else marker.closeTooltip();
    };
    bottone.addEventListener("mouseenter", () => accendi(true));
    bottone.addEventListener("mouseleave", () => accendi(false));
    bottone.addEventListener("focus", () => accendi(true));
    bottone.addEventListener("blur", () => accendi(false));
    marker.on("mouseover", () => li.classList.add("attivo"));
    marker.on("mouseout", () => li.classList.remove("attivo"));
  }
  li.append(bottone);
  el.elenco.append(li);
  stato.voci.push({ li, testo: normalizza(testoRicerca ?? `${nome} ${dettaglio ?? ""}`), extra: classe.includes("risultato") });
}

// ---------- Illustrazioni ----------

/** Miniature delle illustrazioni del luogo, in cima al pannello: clic per vederle intere. */
function mostraVedute(vedute) {
  el.vedute.replaceChildren();
  el.vedute.hidden = !vedute.length;
  for (const veduta of vedute) {
    const bottone = document.createElement("button");
    bottone.type = "button";
    bottone.className = "veduta";
    bottone.setAttribute("aria-label", `${veduta.titolo}: apri l'illustrazione a tutto schermo`);
    const immagine = document.createElement("img");
    immagine.src = veduta.file;
    immagine.alt = veduta.alt ?? "";
    immagine.loading = "lazy";
    immagine.decoding = "async";
    // Se il file manca, la miniatura sparisce invece di mostrare un'immagine rotta
    immagine.addEventListener("error", () => {
      bottone.remove();
      el.vedute.hidden = !el.vedute.children.length;
    });
    const didascalia = document.createElement("span");
    didascalia.className = "didascalia";
    didascalia.innerHTML = `${icona("veduta")}${escape(veduta.titolo)}`;
    bottone.append(immagine, didascalia);
    bottone.addEventListener("click", () => apriLightbox(veduta));
    el.vedute.append(bottone);
  }
}

function apriLightbox(veduta) {
  el.lightboxImmagine.src = veduta.file;
  el.lightboxImmagine.alt = veduta.alt ?? "";
  el.lightboxTitolo.textContent = veduta.titolo;
  el.lightboxNota.textContent = veduta.quando ?? "";
  el.lightboxNota.hidden = !veduta.quando;
  el.lightbox.showModal(); // Esc chiude e il focus resta nella finestra
}

// Clic fuori dall'immagine (sullo sfondo) o sul pulsante: chiude
el.lightbox.addEventListener("click", (evento) => {
  if (evento.target === el.lightbox || evento.target.closest("[data-chiudi]")) el.lightbox.close();
});

function filtra() {
  const cercato = normalizza(el.cerca.value.trim());
  for (const voce of stato.voci) {
    // I POI delle città compaiono solo quando si cerca qualcosa
    voce.li.hidden = cercato ? !voce.testo.includes(cercato) : voce.extra;
  }
}

el.cerca.addEventListener("input", filtra);

function mostraLegenda(righe) {
  el.legenda.innerHTML = righe.map(([simbolo, testo]) => `<div>${simbolo}<span>${escape(testo)}</span></div>`).join("");
  el.legenda.hidden = !righe.length;
}

function mostraLivello(luogo = null) {
  const { regione } = stato.dati;
  if (!luogo) {
    el.livello.innerHTML = `<span class="corrente">${icona("monti")}${escape(regione.nome)}</span>`;
    return;
  }
  const nota = statoMappa(luogo) === "pronta" ? "" : ' <span class="sottotitolo">(vista regionale)</span>';
  el.livello.innerHTML = `<a href="#/">${icona("monti")}${escape(regione.nome)}</a>` +
    `<span class="separatore" aria-hidden="true">›</span>` +
    `<span class="corrente" aria-current="page">${iconaTipo(luogo.tipo)}${escape(luogo.nome)}</span>${nota}`;
}

function pannelloRegione(markerLuoghi) {
  const { regione, luoghi } = stato.dati;
  const conMappa = luoghi.filter((l) => statoMappa(l) === "pronta").length;
  impostaPannello({
    titolo: regione.nome,
    sottotitolo: `${luoghi.length} luoghi · ${conMappa} con mappa interna`,
    descrizione: regione.descrizione,
    intestazione: "Luoghi",
  });

  // Prima i luoghi con una mappa interna, poi gli altri, in fondo quelli non
  // ancora posizionati (a parità, ordine del file)
  const ordine = { pronta: 0, "da-scaricare": 1, assente: 2 };
  const peso = (l) => ordine[statoMappa(l)] + (haPosizione(l) ? 0 : 10);
  const ordinati = [...luoghi].sort((a, b) => peso(a) - peso(b));
  for (const luogo of ordinati) {
    const s = statoMappa(luogo);
    const posizionato = haPosizione(luogo);
    const dettaglio = [luogo.tipo, posizionato ? "" : "da posizionare", luogo.segreto ? "segreto" : ""]
      .filter(Boolean).join(" · ");
    aggiungiVoce({
      inizio: gettone(luogo.tipo, s),
      nome: luogo.nome,
      dettaglio,
      fine: `<span class="fine">${luogo.illustrazioni?.length ? `<span class="con-veduta" title="Ha un'illustrazione">${icona("veduta")}</span>` : ""}${chip(s)}</span>`,
      classe: [posizionato ? "" : "senza-posizione", luogo.segreto ? "segreto" : ""].filter(Boolean).join(" "),
      marker: markerLuoghi.get(luogo.id) ?? null,
      alClic: () => (location.hash = `#/luogo/${encodeURIComponent(luogo.id)}`),
      testoRicerca: `${luogo.nome} ${luogo.tipo} ${luogo.descrizione}`,
    });
  }

  // Risultati di ricerca: i POI di tutte le città
  for (const luogo of luoghi) {
    (luogo.poi || []).forEach((poi, indice) => {
      aggiungiVoce({
        inizio: `<span class="numero">${icona("spillo")}</span>`,
        nome: poi.nome,
        dettaglio: `in ${luogo.nome}`,
        classe: "risultato",
        alClic: () => (location.hash = `#/luogo/${encodeURIComponent(luogo.id)}/${indice}`),
        testoRicerca: `${poi.nome} ${poi.descrizione ?? ""} ${luogo.nome}`,
      });
    });
  }
  filtra();

  const statiLegenda = VISTA_GIOCATORI ? ["pronta", "assente"] : ["pronta", "da-scaricare", "assente"];
  mostraLegenda(statiLegenda.map((s) => [gettone("città", s), STATI[s].legenda]));
}

function pannelloLuogo(luogo, markerPoi) {
  const { regione } = stato.dati;
  const s = statoMappa(luogo);
  const poi = luogo.poi || [];
  impostaPannello({
    titolo: luogo.nome,
    sottotitolo: `${escape(luogo.tipo)} ${chip(s) || '<span class="chip chip-assente">Senza mappa</span>'}` +
      (luogo.segreto ? ' <span class="chip chip-segreto">Segreto</span>' : ""),
    descrizione: luogo.descrizione,
    indietro: `Torna a ${regione.nome}`,
    intestazione: poi.length ? `Punti d'interesse (${poi.length})` : "",
    vedute: luogo.illustrazioni ?? [],
  });

  if (!haPosizione(luogo)) {
    avvisoMaster(`${escape(luogo.nome)} non è ancora sulla mappa regionale: trovare il punto con la ` +
      "modalità Coordinate e aggiungere <code>coord</code> in <code>dati/luoghi.json</code>.");
  } else if (s === "pronta") {
    mostraAvviso("");
  } else if (s === "da-scaricare") {
    avvisoMaster(`La mappa di ${escape(luogo.nome)} non è ancora scaricata: lanciare ` +
      "<code>strumenti/scarica_mappe.py</code> e <code>strumenti/genera_tile.py</code> " +
      "(o salvare l'immagine a mano in <code>mappa/immagini/</code>).");
  } else {
    avvisoMaster(`${escape(luogo.nome)} non ha ancora una mappa interna: aggiungerla in ` +
      "<code>strumenti/scarica_mappe.py</code> e impostare il campo <code>mappa</code> in <code>dati/luoghi.json</code>.");
  }

  poi.forEach((p, indice) => {
    const posizionato = markerPoi.has(indice);
    aggiungiVoce({
      inizio: `<span class="numero${p.segreto ? " segreto" : ""}">${indice + 1}</span>`,
      nome: p.nome,
      dettaglio: p.descrizione,
      classe: posizionato ? "" : "senza-posizione",
      marker: markerPoi.get(indice) ?? null,
      alClic: () => posizionato && evidenziaPoi(indice, markerPoi),
    });
  });
  if (!poi.length) {
    const li = document.createElement("li");
    li.className = "vuoto";
    li.textContent = "Nessun punto d'interesse, per ora.";
    el.elenco.append(li);
  }
  filtra();

  const righe = [];
  if (markerPoi.size) righe.push(['<span class="numero">1</span>', "Sulla mappa: passa col mouse per i dettagli"]);
  if (poi.some((p) => !haPosizione(p)) || (poi.length && s !== "pronta")) {
    righe.push(['<span class="senza-posizione"><span class="numero">·</span></span>',
      VISTA_GIOCATORI ? "Non segnato sulla mappa" : "Da posizionare (modalità Coordinate)"]);
  }
  if (poi.some((p) => p.segreto)) righe.push(['<span class="numero segreto">1</span>', "Segreto, solo per il Master"]);
  mostraLegenda(righe);
}

// ---------- Viste ----------

async function vistaRegione(richiesta, da) {
  const { regione, luoghi } = stato.dati;
  const info = stato.info.get(regione.mappa);
  mostraLivello();
  document.title = `Atlante – ${regione.nome}`;

  if (!info) {
    pannelloRegione(new Map());
    avvisoMaster("Mancano i tile della mappa regionale. Lanciare <code>strumenti/scarica_mappe.py</code> " +
      "e poi <code>strumenti/genera_tile.py</code>.");
    return;
  }
  mostraAvviso("");

  const daLuogo = da?.luogo ? luoghi.find((l) => l.id === da.luogo) : null;
  const precedente = daLuogo && haPosizione(daLuogo) ? daLuogo : null;
  const daAltraMappa = stato.mappaCorrente !== null && stato.mappaCorrente !== regione.mappa;

  if (daAltraMappa) await velo(true);
  if (richiesta !== stato.richiesta) return;

  const limiti = mostraMappa(regione.mappa, info);
  const markerLuoghi = disegnaLuoghi();
  pannelloRegione(markerLuoghi);

  if (precedente) {
    // Uscendo da un luogo: si riparte vicini a esso e ci si allontana
    if (daAltraMappa) mappa.setView(aLatLng(precedente.coord), zoomVicino(1.5), { animate: false });
    await velo(false);
    await vola(aLatLng(precedente.coord), zoomVicino(0.25), 0.8);
  } else {
    if (!daAltraMappa) mappa.fitBounds(limiti, { animate: false });
    await velo(false);
  }
}

async function vistaLuogo(richiesta, idLuogo, indicePoi) {
  const { regione, luoghi } = stato.dati;
  const luogo = luoghi.find((l) => l.id === idLuogo);
  if (!luogo) {
    location.hash = "#/";
    return;
  }
  const infoLuogo = stato.info.get(luogo.mappa) ?? null;
  const infoRegione = stato.info.get(regione.mappa) ?? null;
  const sullaRegione = stato.mappaCorrente === regione.mappa;
  mostraLivello(luogo);
  document.title = `Atlante – ${luogo.nome}`;

  const markerPoi = new Map();

  if (infoLuogo) {
    if (stato.mappaCorrente !== luogo.mappa) {
      // Entrando dalla regione: prima si vola sul luogo, poi si cambia mappa
      if (sullaRegione && haPosizione(luogo)) {
        disegnaLuoghi(luogo.id);
        await vola(aLatLng(luogo.coord), zoomVicino(1.75), 0.8);
        if (richiesta !== stato.richiesta) return;
      }
      if (stato.mappaCorrente !== null) await velo(true);
      if (richiesta !== stato.richiesta) return;
      mostraMappa(luogo.mappa, infoLuogo); // inquadra tutta la mappa del luogo
    }
    stato.strato.clearLayers();
    (luogo.poi || []).forEach((p, indice) => {
      if (!haPosizione(p)) return;
      markerPoi.set(indice, creaMarker(p.coord, {
        classe: `marker-poi${p.segreto ? " segreto" : ""}`,
        html: `<span class="spillo"><b>${indice + 1}</b></span>`,
        dimensione: [28, 28],
        ancora: [14, 34],
        tooltip: schedaPoi(p, indice + 1),
        etichetta: `${indice + 1}. ${p.nome}`,
        alClic: () => evidenziaPoi(indice, markerPoi),
      }));
    });
    pannelloLuogo(luogo, markerPoi);
    await velo(false);
  } else {
    // Nessuna mappa interna: il luogo si mostra sulla mappa regionale
    if (!infoRegione) {
      pannelloLuogo(luogo, markerPoi);
      return;
    }
    if (!sullaRegione && stato.mappaCorrente !== null) await velo(true);
    if (richiesta !== stato.richiesta) return;
    const primaVolta = stato.mappaCorrente === null;
    mostraMappa(regione.mappa, infoRegione);
    disegnaLuoghi(luogo.id);
    pannelloLuogo(luogo, markerPoi);
    if (!haPosizione(luogo)) {
      // Non ancora posizionato: si resta sulla vista d'insieme
      if (!sullaRegione) mappa.fitBounds(stato.limiti, { animate: false });
      await velo(false);
    } else if (primaVolta || !sullaRegione) {
      mappa.setView(aLatLng(luogo.coord), zoomVicino(1.5), { animate: false });
      await velo(false);
    } else {
      await vola(aLatLng(luogo.coord), zoomVicino(1.5), 0.8);
    }
  }

  if (richiesta === stato.richiesta && indicePoi != null && markerPoi.has(indicePoi)) {
    evidenziaPoi(indicePoi, markerPoi);
  }
}

async function evidenziaPoi(indice, markerPoi) {
  const marker = markerPoi.get(indice);
  for (const [i, m] of markerPoi) m.getElement()?.classList.toggle("evidenziato", i === indice);
  stato.voci.forEach((voce, i) => voce.li.classList.toggle("attivo", i === indice));
  stato.voci[indice]?.li.scrollIntoView({ block: "nearest" });
  await vola(marker.getLatLng(), Math.max(mappa.getZoom(), stato.zoomMax), 0.6);
  marker.openTooltip();
}

// ---------- Navigazione ----------

function leggiPercorso() {
  const parti = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parti[0] === "luogo" && parti[1]) {
    const indice = Number.parseInt(parti[2], 10);
    return { luogo: parti[1], poi: Number.isNaN(indice) ? null : indice };
  }
  return { luogo: null, poi: null };
}

async function aggiorna() {
  const richiesta = ++stato.richiesta;
  const percorso = leggiPercorso();
  const da = stato.percorso;
  stato.percorso = percorso;
  el.cerca.value = "";
  mappa.closePopup();
  if (percorso.luogo) await vistaLuogo(richiesta, percorso.luogo, percorso.poi);
  else await vistaRegione(richiesta, da);
  if (richiesta === stato.richiesta) el.velo.classList.remove("attivo");
}

window.addEventListener("hashchange", aggiorna);

// ---------- Controlli sulla mappa ----------

const Controllo = L.Control.extend({
  onAdd() {
    const contenitore = this.options.elemento;
    L.DomEvent.disableClickPropagation(contenitore);
    L.DomEvent.disableScrollPropagation(contenitore);
    return contenitore;
  },
});
new Controllo({ position: "bottomright", elemento: el.zoom }).addTo(mappa);
if (VISTA_GIOCATORI) el.strumenti.remove();
else new Controllo({ position: "bottomleft", elemento: el.strumenti }).addTo(mappa);

el.zoom.addEventListener("click", (evento) => {
  const azione = evento.target.closest("button")?.dataset.azione;
  if (azione === "piu") mappa.zoomIn();
  if (azione === "meno") mappa.zoomOut();
  if (azione === "intera" && stato.limiti) mappa.flyToBounds(stato.limiti, { duration: riduciMovimento ? 0 : 0.6 });
});

function aggiornaPulsantiZoom() {
  const zoom = mappa.getZoom();
  el.zoom.querySelector('[data-azione="piu"]').disabled = zoom >= mappa.getMaxZoom();
  el.zoom.querySelector('[data-azione="meno"]').disabled = zoom <= mappa.getMinZoom();
}

mappa.on("zoomend zoomlevelschange", aggiornaPulsantiZoom);

// ---------- Modalità editor: coordinate per luoghi.json ----------

async function copiaCoordinate(coord, latlng) {
  const testo = `[${coord[0]}, ${coord[1]}]`;
  let copiato = false;
  try {
    await navigator.clipboard.writeText(testo);
    copiato = true;
  } catch {
    copiato = false; // appunti non disponibili: resta il popup da cui copiare a mano
  }
  L.popup({ autoClose: true })
    .setLatLng(latlng)
    .setContent(`<code>${testo}</code>${copiato ? "<br>copiato negli appunti" : ""}`)
    .openOn(mappa);
}

function impostaEditor(attivo) {
  stato.editor = attivo;
  el.editor.setAttribute("aria-pressed", String(attivo));
  el.mappa.classList.toggle("editor", attivo);
  el.cursore.hidden = !attivo;
  if (!attivo) mappa.closePopup();
}

if (!VISTA_GIOCATORI) {
  el.editor.addEventListener("click", () => impostaEditor(!stato.editor));

  document.addEventListener("keydown", (evento) => {
    const inScrittura = evento.target.closest("input, textarea") || el.lightbox.open;
    if (!inScrittura && evento.key.toLowerCase() === "e" && !evento.metaKey && !evento.ctrlKey && !evento.altKey) {
      impostaEditor(!stato.editor);
    }
  });
}

mappa.on("mousemove", (evento) => {
  if (!stato.editor) return;
  const [x, y] = aPixel(evento.latlng);
  el.cursore.value = `${stato.mappaCorrente} [${x}, ${y}]`;
});

mappa.on("click", (evento) => {
  if (stato.editor) copiaCoordinate(aPixel(evento.latlng), evento.latlng);
});

// ---------- Avvio ----------

async function avvio() {
  try {
    const risposta = await fetch("dati/luoghi.json");
    if (!risposta.ok) throw new Error(`HTTP ${risposta.status}`);
    stato.dati = await risposta.json();
  } catch (errore) {
    el.titolo.textContent = "Dati non caricati";
    if (VISTA_GIOCATORI) {
      mostraAvviso(`Riprova a ricaricare la pagina. Dettaglio: ${escape(errore.message)}`);
      return;
    }
    mostraAvviso("Aprire la pagina dal server locale: <code>.venv/bin/python -m http.server 8000 " +
      "--bind 127.0.0.1 --directory mappa</code> e poi <code>http://localhost:8000</code>. " +
      `Dettaglio: ${escape(errore.message)}`);
    return;
  }
  // Serve sapere subito quali luoghi hanno una mappa interna pronta
  await caricaIndice();
  await aggiorna();
}

avvio();
