// Edge Function "woocommerce-sync": haalt betaalde WooCommerce-bestellingen op en zet ze in het dashboard.
// Wordt ingepland door pg_cron en meldt zich met het geheim uit de Vault (header x-sync-geheim).
// Haalt alles op wat sinds de laatste geslaagde run is gewijzigd, dus een storing haalt zichzelf in.
// Een bestelling die er al staat wordt niet overschreven (zie nieuwe_bestelling).
// Secrets: WOO_CONSUMER_KEY en WOO_CONSUMER_SECRET (alleen-lezen sleutel uit WooCommerce).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const WINKEL = "https://graanenzo.nl";
const OVERLAP_MS = 10 * 60 * 1000;
// In WooCommerce staan duizenden oude bestellingen nog op "In behandeling". Als zo'n oude bestelling wordt
// gewijzigd, mag hij niet opnieuw bij verpakken verschijnen. Daarom ook een grens op de besteldatum.
const MAX_LEEFTIJD_MS = 7 * 24 * 60 * 60 * 1000;
const NOOIT_VOOR = Date.parse("2026-10-31T12:00:00Z");
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const LANDEN: Record<string, string> = { NL: "Nederland", BE: "België", DE: "Duitsland", FR: "Frankrijk", LU: "Luxemburg" };
const rond = (v: unknown) => Math.round(Number(v || 0) * 100) / 100;
const leeg = (v: unknown) => (v && String(v).trim()) || null;

type Rec = Record<string, any>;

function meta(o: Rec, key: string) {
  const m = (o.meta_data || []).find((x: Rec) => x.key === key);
  if (!m) return null;
  if (typeof m.value === "string") {
    try { return JSON.parse(m.value); } catch (_) { return m.value; }
  }
  return m.value;
}

const naam = (a: Rec) => leeg([a?.first_name, a?.last_name].filter(Boolean).join(" "));
const land = (a: Rec) => (a?.country ? LANDEN[a.country] || a.country : null);

// Plakt adresregel 2 erachter, tenzij het huisnummer daar dubbel in zou komen ("Beijlkensweg, 60" + "60")
function straat(a: Rec) {
  const a1 = String(a?.address_1 || "").trim();
  const a2 = String(a?.address_2 || "").trim();
  if (!a2 || a1.endsWith(a2) || a1.split(/[\s,]+/).includes(a2)) return a1 || null;
  return `${a1} ${a2}`.trim() || null;
}

function naarBestelling(o: Rec) {
  const b = o.billing || {};
  const s = o.shipping && (o.shipping.address_1 || o.shipping.city) ? o.shipping : b;
  const regels = o.line_items || [];

  const producten = regels.map((r: Rec) => {
    const extra = (r.meta_data || [])
      .filter((m: Rec) => m.display_key && !String(m.key || "").startsWith("_") && m.display_value && !String(r.name).includes(String(m.display_value)))
      .map((m: Rec) => `${String(m.display_key).replace(/:$/, "")}: ${String(m.display_value).replace(/<[^>]+>/g, "")}`);
    return { product: [r.name, ...extra].join(" – "), aantal: Number(r.quantity) || 1, prijs: rond(Number(r.total) + Number(r.total_tax)) };
  });
  const subtotaal = regels.reduce((t: number, r: Rec) => t + Number(r.subtotal || 0) + Number(r.subtotal_tax || 0), 0);

  return {
    ordernummer: String(o.number || o.id),
    besteld_op: String(o.date_created || "").slice(0, 10) || null,
    besteld_om: o.date_created_gmt ? o.date_created_gmt + "Z" : null,
    bron: "woocommerce",
    klantnaam: naam(b) || naam(s),
    email: leeg(b.email),
    telefoon: leeg(b.phone) || leeg(s.phone),
    verzend_naam: naam(s),
    verzend_bedrijf: leeg(s.company),
    verzend_adres: straat(s),
    verzend_postcode: s.postcode ? String(s.postcode).toUpperCase() : null,
    verzend_plaats: leeg(s.city),
    verzend_land: land(s),
    factuur_adres: leeg([b.company, straat(b), [b.postcode, b.city].filter(Boolean).join(" "), land(b)].filter(Boolean).join(", ")),
    verzendmethode: leeg((o.shipping_lines || []).map((l: Rec) => l.method_title).filter(Boolean).join(", ")),
    betaalmethode: leeg(o.payment_method_title),
    subtotaal: rond(subtotaal),
    verzendkosten: rond(Number(o.shipping_total || 0) + Number(o.shipping_tax || 0)),
    totaal: rond(o.total),
    klantnotitie: leeg(o.customer_note),
    myparcel: {
      ontvanger: {
        cc: s.country || "NL",
        person: naam(s),
        company: leeg(s.company),
        address_1: leeg(s.address_1),
        address_2: leeg(s.address_2),
        postal_code: leeg(s.postcode),
        city: leeg(s.city),
        email: leeg(b.email),
        phone: leeg(s.phone) || leeg(b.phone),
      },
      bezorgopties: meta(o, "_myparcel_delivery_options"),
      extra: meta(o, "_myparcel_shipment_options_extra"),
    },
    producten,
  };
}

async function haalBestellingen(vanaf: Date, sleutel: string, geheim: string) {
  const besteldNa = new Date(Math.max(vanaf.getTime() - MAX_LEEFTIJD_MS, NOOIT_VOOR));
  const alles: Rec[] = [];
  for (let pagina = 1; ; pagina++) {
    const url = new URL(`${WINKEL}/wp-json/wc/v3/orders`);
    url.searchParams.set("status", "processing");
    url.searchParams.set("modified_after", vanaf.toISOString().slice(0, 19));
    url.searchParams.set("after", besteldNa.toISOString().slice(0, 19));
    url.searchParams.set("dates_are_gmt", "true");
    url.searchParams.set("orderby", "date");
    url.searchParams.set("order", "asc");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(pagina));
    const r = await fetch(url, {
      headers: { Authorization: "Basic " + btoa(`${sleutel}:${geheim}`), Accept: "application/json", "User-Agent": "GraanEnZo-Verpakken/1.0" },
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`WooCommerce gaf code ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const deel = await r.json();
    if (!Array.isArray(deel)) throw new Error("WooCommerce gaf geen lijst met bestellingen terug");
    alles.push(...deel);
    if (pagina >= Number(r.headers.get("X-WP-TotalPages") || 1)) return alles;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { fout: "Alleen POST" });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const { data: toegang } = await sb.rpc("woo_sync_geheim_ok", { p: req.headers.get("x-sync-geheim") ?? "" });
  if (toegang !== true) return json(401, { fout: "Geen toegang" });

  const start = new Date();
  const bewaar = (velden: Rec) => sb.from("woo_sync_status").update({ laatste_poging: start.toISOString(), ...velden }).eq("id", true);

  const sleutel = Deno.env.get("WOO_CONSUMER_KEY");
  const geheim = Deno.env.get("WOO_CONSUMER_SECRET");
  if (!sleutel || !geheim) {
    const fout = "WOO_CONSUMER_KEY of WOO_CONSUMER_SECRET ontbreekt in Supabase";
    await bewaar({ laatste_fout: fout });
    return json(500, { fout });
  }

  const { data: stand, error: standFout } = await sb.from("woo_sync_status").select("laatste_succes").eq("id", true).single();
  if (standFout || !stand) return json(500, { fout: "Sync-status niet gevonden" });

  let bestellingen: Rec[];
  try {
    bestellingen = await haalBestellingen(new Date(new Date(stand.laatste_succes).getTime() - OVERLAP_MS), sleutel, geheim);
  } catch (e) {
    const fout = String((e as Error).message ?? e);
    console.log("ophalen mislukt", fout);
    await bewaar({ laatste_fout: fout });
    return json(502, { fout });
  }

  let aangemaakt = 0;
  const mislukt: string[] = [];
  for (const o of bestellingen) {
    const { data, error } = await sb.rpc("nieuwe_bestelling", { p: naarBestelling(o) });
    if (error) {
      console.log("opslaan mislukt", o.number || o.id, error.message);
      mislukt.push(String(o.number || o.id));
    } else if (data?.status === "aangemaakt") {
      aangemaakt++;
    }
  }

  const fout = mislukt.length ? `Niet opgeslagen: ${mislukt.join(", ")}` : null;
  // Alleen vooruit als alles gelukt is, anders worden de mislukte bestellingen de volgende keer opnieuw geprobeerd
  await bewaar({
    laatste_fout: fout,
    laatst_opgehaald: bestellingen.length,
    ...(fout ? {} : { laatste_succes: start.toISOString() }),
  });
  return json(fout ? 502 : 200, { opgehaald: bestellingen.length, aangemaakt, mislukt });
});
