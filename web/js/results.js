// Results view: the list of photos (left) and their outlines on the sky (right), linked together.
import { decText, raText } from "./format.js";

const $ = (id) => document.getElementById(id);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Visit colours: muted, distinct from each other on the dark sky, none of them bright.
const VISIT_COLOURS = ["#7F9DBB", "#7FA89F", "#B08C9B", "#B3A47E", "#9C98B8", "#B48E7C"];

export const visitColour = (v) => VISIT_COLOURS[v % VISIT_COLOURS.length];

function shortDate(utc) { return `${Number(utc.slice(8, 10))} ${MONTHS[Number(utc.slice(5, 7)) - 1]} ${utc.slice(0, 4)}`; }
function monthYear(utc) { return `${MONTHS[Number(utc.slice(5, 7)) - 1]} ${utc.slice(0, 4)}`; }

export function visitLabel(v) {
  const a = monthYear(v.start), b = monthYear(v.end);
  return a === b ? a : `${a.split(" ")[0]}${a.slice(-4) === b.slice(-4) ? "" : " " + a.slice(-4)}–${b}`;
}

export class Results {
  constructor(A, aladin) {
    this.A = A;
    this.aladin = aladin;
    this.data = null;
    this.hiddenVisits = new Set();
    this.sort = { key: "mjd", dir: 1 };
    this.selected = -1;
    this.outlines = new Map();     // visit → overlay
    this.selection = A.graphicOverlay({ color: "#DCE3EC", lineWidth: 2.5 });
    this.centres = A.catalog({ name: "Photo centres", shape: "square", sourceSize: 9, color: "#9DB2C8" });
    aladin.addOverlay(this.selection);
    aladin.addCatalog(this.centres);
    this.centres.hide();

    aladin.on("objectClicked", (obj) => {
      const i = obj && obj.data && Number.isInteger(obj.data.i) ? obj.data.i : -1;
      if (i >= 0) this.select(i, true);
    });
    $("show-outlines").addEventListener("change", () => this.applyVisibility());
    $("show-centres").addEventListener("change", () => this.applyVisibility());
    for (const b of document.querySelectorAll(".photos th button")) {
      b.addEventListener("click", () => {
        const key = b.dataset.sort;
        this.sort = { key, dir: this.sort.key === key ? -this.sort.dir : 1 };
        for (const o of document.querySelectorAll(".photos th button")) o.removeAttribute("aria-sort");
        b.setAttribute("aria-sort", this.sort.dir > 0 ? "ascending" : "descending");
        this.renderRows();
      });
    }
  }

  show(data, place) {
    this.data = data;
    this.selected = -1;
    this.hiddenVisits.clear();
    $("results-title").textContent = place.name || "Your position";
    $("results-where").textContent = `${raText(data.ra)}  ${decText(data.dec)}`;
    const n = data.total, nv = data.visits.length;
    const filtered = data.total_all !== data.total ? ` (of ${data.total_all} before your filters)` : "";
    $("results-summary").textContent = n
      ? `SPHEREx took ${n} photo${n === 1 ? "" : "s"} of this spot${filtered}, during ${nv} visit${nv === 1 ? "" : "s"}.`
      : "";
    $("results-empty").hidden = n > 0;
    $("results-empty").textContent = data.total_all === 0
      ? "SPHEREx has no photos of this spot yet. It maps the whole sky every six months, so try again later, or try another place."
      : "No photos match your filters. Widen the dates or colours in the search panel.";
    $("table-wrap").hidden = n === 0;
    this.renderVisits();
    this.drawOutlines();
    this.renderRows();
    this.selection.removeAll();
  }

  renderVisits() {
    const ul = $("visits");
    ul.replaceChildren();
    for (const v of this.data.visits) {
      const li = document.createElement("li"), b = document.createElement("button");
      b.type = "button";
      b.setAttribute("aria-pressed", "true");
      const dot = document.createElement("span"), label = document.createElement("span"), count = document.createElement("span");
      dot.className = "swatch";
      dot.style.background = visitColour(v.visit);
      label.textContent = `Visit ${v.visit + 1}: ${visitLabel(v)}`;
      count.className = "count";
      count.textContent = String(v.n);
      b.append(dot, label, count);
      b.addEventListener("click", () => {
        const hide = !this.hiddenVisits.has(v.visit);
        if (hide) this.hiddenVisits.add(v.visit); else this.hiddenVisits.delete(v.visit);
        b.setAttribute("aria-pressed", String(!hide));
        this.applyVisibility();
        this.renderRows();
      });
      li.append(b);
      ul.append(li);
    }
  }

  drawOutlines() {
    for (const o of this.outlines.values()) { o.removeAll(); o.hide(); }
    this.centres.removeAll();
    const byVisit = new Map();
    this.data.photos.forEach((p, i) => {
      if (!byVisit.has(p.visit)) byVisit.set(p.visit, []);
      byVisit.get(p.visit).push([p, i]);
    });
    for (const [v, list] of byVisit) {
      let o = this.outlines.get(v);
      if (!o) {
        o = this.A.graphicOverlay({ color: visitColour(v), lineWidth: 1 });
        this.aladin.addOverlay(o);
        this.outlines.set(v, o);
      }
      for (const [p] of list) if (p.outline.length >= 3) o.add(this.A.polygon(p.outline));
    }
    this.centres.addSources(this.data.photos.map((p, i) => this.A.source(p.centre[0], p.centre[1], { i })));
    // Keep the highlight on top of the visit outlines that were just added.
    this.aladin.removeOverlay(this.selection);
    this.aladin.addOverlay(this.selection);
    this.applyVisibility();
  }

  applyVisibility() {
    const outlinesOn = $("show-outlines").checked;
    for (const [v, o] of this.outlines) {
      const on = outlinesOn && this.data && this.data.visits.some((x) => x.visit === v) && !this.hiddenVisits.has(v);
      if (on) o.show(); else o.hide();
    }
    if ($("show-centres").checked) this.centres.show(); else this.centres.hide();
  }

  renderRows() {
    const tbody = $("photo-rows");
    tbody.replaceChildren();
    if (!this.data) return;
    const { key, dir } = this.sort;
    const order = this.data.photos.map((p, i) => i).filter((i) => !this.hiddenVisits.has(this.data.photos[i].visit));
    order.sort((a, b) => {
      const pa = this.data.photos[a], pb = this.data.photos[b];
      return (pa[key] < pb[key] ? -1 : pa[key] > pb[key] ? 1 : pa.mjd - pb.mjd) * dir;
    });
    const frag = document.createDocumentFragment();
    for (const i of order) {
      const p = this.data.photos[i];
      const tr = document.createElement("tr");
      tr.dataset.i = String(i);
      tr.setAttribute("aria-selected", String(i === this.selected));
      const cells = [
        `${shortDate(p.utc)}  ${p.utc.slice(11, 16)}`,
        null,
        `${p.det} of 6`,
        `${p.um[0].toFixed(2)}–${p.um[1].toFixed(2)} µm`,
        p.release,
        null,
      ];
      cells.forEach((text, k) => {
        const td = document.createElement("td");
        if (k === 1) {
          const dot = document.createElement("span");
          dot.className = "visit-dot";
          dot.style.background = visitColour(p.visit);
          td.append(dot, document.createTextNode(String(p.visit + 1)));
        } else if (k === 3) {
          td.className = "um";
          td.textContent = text;
        } else if (k === 5) {
          if (p.url.startsWith("https://irsa.ipac.caltech.edu/")) {
            const a = document.createElement("a");
            a.href = p.url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = "File";
            a.title = "Original file at NASA's archive (65 MB)";
            a.addEventListener("click", (e) => e.stopPropagation());
            td.append(a);
          }
        } else {
          td.textContent = text;
        }
        tr.append(td);
      });
      tr.addEventListener("click", () => this.select(i, false));
      frag.append(tr);
    }
    tbody.append(frag);
  }

  select(i, fromSky) {
    this.selected = i;
    const p = this.data.photos[i];
    this.selection.removeAll();
    if (p.outline.length >= 3) this.selection.add(this.A.polygon(p.outline));
    for (const tr of $("photo-rows").children) tr.setAttribute("aria-selected", String(Number(tr.dataset.i) === i));
    if (fromSky) {
      const row = $("photo-rows").querySelector(`tr[data-i="${i}"]`);
      if (row) row.scrollIntoView({ block: "center" });
    }
  }

  clear() {
    for (const o of this.outlines.values()) { o.removeAll(); o.hide(); }
    this.centres.removeAll();
    this.selection.removeAll();
    this.data = null;
  }
}
