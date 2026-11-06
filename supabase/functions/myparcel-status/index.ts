// Edge Function "myparcel-status": neemt de status van zendingen uit MyParcel over in het dashboard.
// Aangeboden aan de vervoerder of verder: de bestelling gaat op "verzonden" en verdwijnt uit het dashboard.
// Voorgemeld: de bestelling blijft staan, met zending-id en barcode, zodat er geen tweede label wordt gemaakt.
// Met ?proef=1 wordt niets opgeslagen en komt alleen het resultaat terug.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const MP = "https://api.myparcel.nl";
const DAG_MS = 86400000;
const MAX_LEEFTIJD_DAGEN = 60;
const MARGE_MS = 3 * 3600000; // MyParcel geeft lokale tijd zonder tijdzone
const ONDERWEG = new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 19, 32, 33, 34, 35, 36, 37, 38]);
const ONGELDIG = new Set([13, 16, 17]); // gecrediteerd, verlopen, geannuleerd

type Rec = Record<string, any>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const norm = (x: unknown) => String(x ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const ref = (x: unknown) => String(x ?? "").replace(/^#/, "").trim();
const tijd = (z: Rec) => Date.parse(String(z.created ?? "").replace(" ", "T") + "Z");

async function haalZendingen(vanaf: Date, key: string) {
  const alles: Rec[] = [];
  for (let pagina = 1; pagina <= 50; pagina++) {
    const url = `${MP}/shipments?from=${vanaf.toISOString().slice(0, 10)}&size=200&page=${pagina}`;
    const r = await fetch(url, {
      headers: { Authorization: "basic " + btoa(key), "User-Agent": "GraanEnZo-Verpakken/1.0", Accept: "application/json;charset=utf-8" },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`MyParcel gaf code ${r.status}`);
    const d = await r.json();
    const deel = (d?.data?.shipments ?? d?.data?.search_results?.shipments ?? []) as Rec[];
    alles.push(...deel);
    if (deel.length < 200) return alles;
  }
  throw new Error("Te veel zendingen om op te halen");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { fout: "Alleen POST" });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: toegang } = await sb.rpc("woo_sync_geheim_ok", { p: req.headers.get("x-sync-geheim") ?? "" });
  if (toegang !== true) return json(401, { fout: "Geen toegang" });

  const proef = new URL(req.url).searchParams.get("proef") === "1";
  const key = Deno.env.get("MYPARCEL_API_KEY");
  if (!key) return json(500, { fout: "MYPARCEL_API_KEY ontbreekt" });

  const grens = new Date(Date.now() - MAX_LEEFTIJD_DAGEN * DAG_MS).toISOString().slice(0, 10);
  const { data: rijen, error } = await sb.from("bestellingen")
    .select("id, ordernummer, status, besteld_om, besteld_op, created_at, verzend_postcode, verzend_naam, verzend_bedrijf, verzendmethode, myparcel_zending_id, myparcel_status, barcode")
    .in("status", ["nieuw", "bezig", "verpakt"]).gte("besteld_op", grens);
  if (error) return json(500, { fout: error.message });
  const open = (rijen ?? []).filter((b: Rec) => !/afhal/i.test(String(b.verzendmethode ?? "")));
  if (!open.length) return json(200, { gecontroleerd: 0 });

  const start = (b: Rec) => Date.parse(b.besteld_om ?? `${b.besteld_op ?? String(b.created_at).slice(0, 10)}T00:00:00Z`);
  const oudste = new Date(Math.min(...open.map(start)) - DAG_MS);

  let zendingen: Rec[];
  try { zendingen = (await haalZendingen(oudste, key)).filter((z) => !ONGELDIG.has(Number(z.status))); }
  catch (e) { console.log("ophalen mislukt", String(e)); return json(502, { fout: String((e as Error).message ?? e) }); }

  const opId = new Map(zendingen.map((z) => [Number(z.id), z]));
  const eigenRefs = new Set(open.map((b: Rec) => String(b.ordernummer)));
  const gekoppeld = new Map<string, { z: Rec; herkomst: string }>();
  const postcodeKandidaten = new Map<number, string[]>();

  for (const b of open) {
    const eerder = Number(b.myparcel_zending_id);
    if (eerder > 0 && opId.has(eerder)) { gekoppeld.set(b.id, { z: opId.get(eerder)!, herkomst: "opgeslagen" }); continue; }
    const opRef = zendingen.filter((z) => ref(z.reference_identifier) === String(b.ordernummer) && tijd(z) >= start(b) - DAG_MS);
    if (opRef.length) {
      gekoppeld.set(b.id, { z: opRef.sort((x, y) => Number(y.id) - Number(x.id))[0], herkomst: "referentie" });
      continue;
    }
    // Op postcode en naam, alleen als het eenduidig is: een herhaalbestelling mag niet de zending van een andere bestelling krijgen
    const pc = norm(b.verzend_postcode);
    if (!pc) continue;
    const achternaam = norm(String(b.verzend_naam ?? "").trim().split(/\s+/).slice(-1)[0]);
    const kand = zendingen.filter((z) => {
      const r = (z.recipient ?? {}) as Rec;
      const naam = norm(r.person) + norm(r.company);
      const andereRef = ref(z.reference_identifier);
      return norm(r.postal_code) === pc && !!achternaam && naam.includes(achternaam)
        && tijd(z) >= start(b) - MARGE_MS && !(andereRef && eigenRefs.has(andereRef));
    });
    if (kand.length === 1) {
      const id = Number(kand[0].id);
      postcodeKandidaten.set(id, [...(postcodeKandidaten.get(id) ?? []), b.id]);
    }
  }
  const bezet = new Set([...gekoppeld.values()].map((g) => Number(g.z.id)));
  for (const [id, bestellingen] of postcodeKandidaten) {
    if (bestellingen.length === 1 && !bezet.has(id)) gekoppeld.set(bestellingen[0], { z: opId.get(id)!, herkomst: "postcode" });
  }

  const nu = new Date().toISOString();
  const uitslag: Rec[] = [];
  let verzonden = 0, bijgewerkt = 0;
  const mislukt: string[] = [];
  for (const b of open) {
    const g = gekoppeld.get(b.id);
    if (!g) { uitslag.push({ nr: b.ordernummer, dashboard: b.status, zending: null }); continue; }
    const mpStatus = Number(g.z.status);
    const barcode = String(g.z.barcode ?? "").trim();
    const wordtVerzonden = ONDERWEG.has(mpStatus);
    uitslag.push({ nr: b.ordernummer, dashboard: b.status, zending: g.z.id, herkomst: g.herkomst, mp_status: mpStatus, ref: g.z.reference_identifier ?? null, aangemaakt: g.z.created, barcode: !!barcode, wordt_verzonden: wordtVerzonden });
    if (proef) continue;
    const patch: Rec = {};
    if (Number(b.myparcel_status) !== mpStatus) { patch.myparcel_status = mpStatus; patch.myparcel_status_op = nu; }
    if (!(Number(b.myparcel_zending_id) > 0) && b.myparcel_zending_id !== -1) patch.myparcel_zending_id = Number(g.z.id);
    if (barcode && !b.barcode) patch.barcode = barcode;
    if (wordtVerzonden) { patch.status = "verzonden"; patch.verzonden_op = nu; verzonden++; }
    if (!Object.keys(patch).length) continue;
    const { error: fout } = await sb.from("bestellingen").update(patch).eq("id", b.id);
    if (fout) { console.log("opslaan mislukt", b.ordernummer, fout.message); mislukt.push(String(b.ordernummer)); } else bijgewerkt++;
  }
  return json(mislukt.length ? 502 : 200, { proef, zendingen: zendingen.length, gecontroleerd: open.length, gekoppeld: gekoppeld.size, bijgewerkt, verzonden, mislukt, uitslag });
});
