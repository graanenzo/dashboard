// Edge Function "myparcel-label": maakt (indien nodig) de zending aan in MyParcel, meldt hem aan bij de
// vervoerder door het label op te vragen, slaat zending-id en barcode op en geeft het label als PDF terug.
// Standaard voor de Epson-labelprinter: A6-label op een staande pagina van 102 x 150 mm (doorlopende rol 102 mm).
// Een liggend label wordt een kwartslag gedraaid, zodat het de rol vult en de browser automatisch "staand" kiest.
// Met { formaat: "a4" } komt het label op A4.
// De MyParcel API-sleutel staat als secret MYPARCEL_API_KEY in Supabase en komt nooit in de browser.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { PDFDocument, degrees } from "npm:pdf-lib@1.17.1";

const MP = "https://api.myparcel.nl";
const MM = 72 / 25.4;
const ROL = { breedte: 102, hoogte: 150, marge: 2 }; // mm, staand
const BEZIG = -1; // tijdelijke waarde in myparcel_zending_id terwijl de zending wordt aangemaakt
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "content-disposition, x-barcode",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const VERVOERDERS: Record<string, number> = { postnl: 1, bpost: 2, dpd: 4 };
const PAKKETSOORT: Record<string, number> = { package: 1, mailbox: 2, letter: 3, digital_stamp: 4, package_small: 6 };
const BEZORGSOORT: Record<string, number> = { morning: 1, standard: 2, evening: 3, pickup: 4, express: 5 };

// Zet elk label zo groot mogelijk op een staande pagina. Een liggend label wordt een kwartslag gedraaid.
async function opRol(pdf: Uint8Array): Promise<Uint8Array> {
  const bron = await PDFDocument.load(pdf);
  const uit = await PDFDocument.create();
  const W = ROL.breedte * MM, H = ROL.hoogte * MM, m = ROL.marge * MM;
  const paginas = await uit.embedPdf(bron, bron.getPageIndices());
  for (const p of paginas) {
    const pg = uit.addPage([W, H]);
    if (p.width <= p.height) {
      const s = Math.min((W - 2 * m) / p.width, (H - 2 * m) / p.height);
      pg.drawPage(p, { x: (W - p.width * s) / 2, y: (H - p.height * s) / 2, width: p.width * s, height: p.height * s });
    } else {
      // 90 graden tegen de klok in om de linkeronderhoek: beslaat x-h..x en y..y+w
      const s = Math.min((W - 2 * m) / p.height, (H - 2 * m) / p.width);
      const w = p.width * s, h = p.height * s;
      pg.drawPage(p, { x: (W + h) / 2, y: (H - w) / 2, width: w, height: h, rotate: degrees(90) });
    }
  }
  return await uit.save();
}

// "Stratosfeerstraat 175", "Dorpsstraat 12 A", "Kerkweg 3-bis" -> straat / nummer / toevoeging
function splitAdres(regel1: string, regel2: string | null) {
  const r = String(regel1 || "").trim().replace(/\s+/g, " ");
  const m = r.match(/^(.*[A-Za-z].*?)[\s,]+(\d{1,5})(?:\s*[-\/]?\s*([A-Za-z]{1,4}|[A-Za-z]?\d{1,3}[A-Za-z]?))?$/);
  if (!m) return null;
  let toevoeging = (m[3] || "").trim();
  const extra = String(regel2 || "").trim();
  if (extra && extra.length <= 8 && !toevoeging) toevoeging = extra;
  return { street: m[1].trim(), number: m[2], number_suffix: toevoeging || undefined };
}

const ja = (v: unknown) => (v === true || v === 1 || v === "1" ? 1 : 0);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { fout: "Alleen POST" });

  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: user } = await sb.auth.getUser();
  if (!user?.user) return json(401, { fout: "Niet ingelogd" });

  const key = Deno.env.get("MYPARCEL_API_KEY");
  if (!key) return json(500, { fout: "De MyParcel API-sleutel is nog niet ingesteld in Supabase (secret MYPARCEL_API_KEY)." });

  let ordernummer = "";
  let formaat = "rol";
  try {
    const body = await req.json();
    ordernummer = String(body.ordernummer ?? "").replace(/^#/, "").trim();
    if (String(body.formaat ?? "").toLowerCase() === "a4") formaat = "a4";
  } catch (_) { /* leeg */ }
  if (!/^[\w-]{1,40}$/.test(ordernummer)) return json(400, { fout: "Ongeldig ordernummer" });

  const { data: best, error: dbFout } = await sb.from("bestellingen").select("*").eq("ordernummer", ordernummer).maybeSingle();
  if (dbFout || !best) return json(404, { fout: `Bestelling #${ordernummer} niet gevonden in het dashboard.` });

  const mpHeaders = { Authorization: "basic " + btoa(key), "User-Agent": "GraanEnZo-Verpakken/1.0" };

  async function zoek(params: string) {
    const r = await fetch(`${MP}/shipments?${params}&size=30`, { headers: { ...mpHeaders, Accept: "application/json;charset=utf-8" } });
    if (r.status === 401 || r.status === 403) throw new Error("auth");
    if (!r.ok) throw new Error("zoek " + r.status);
    const d = await r.json();
    return (d?.data?.shipments ?? []) as Array<Record<string, unknown>>;
  }
  async function haalZending(id: number) {
    const r = await fetch(`${MP}/shipments/${id}`, { headers: { ...mpHeaders, Accept: "application/json;charset=utf-8" } });
    if (!r.ok) return null;
    const d = await r.json();
    return ((d?.data?.shipments ?? [])[0] ?? null) as Record<string, unknown> | null;
  }

  const norm = (x: unknown) => String(x ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const besteldVanaf = new Date(String(best.besteld_op || best.created_at).slice(0, 10) + "T00:00:00Z").getTime() - 86400000;
  const naNaBestelling = (z: Record<string, unknown>) => {
    const t = Date.parse(String(z.created ?? "").replace(" ", "T"));
    return !Number.isFinite(t) || t >= besteldVanaf;
  };

  // 1. Zending die we eerder voor deze bestelling hebben aangemaakt of gevonden
  let id: number | null = best.myparcel_zending_id && best.myparcel_zending_id > 0 ? Number(best.myparcel_zending_id) : null;
  let herkomst = id ? "opgeslagen" : "";

  try {
    // 2. Zending met dit ordernummer als referentie
    if (!id) {
      const z = (await zoek("reference_identifier=" + encodeURIComponent(ordernummer))).filter(naNaBestelling);
      if (z.length) { id = Number(z.sort((a, b) => Number(b.id) - Number(a.id))[0].id); herkomst = "referentie"; }
    }
    // 3. Zending die iemand ná de bestelling in MyParcel zelf heeft gemaakt (zelfde postcode en achternaam)
    if (!id && best.verzend_postcode) {
      const pc = norm(best.verzend_postcode);
      const achternaam = norm(String(best.verzend_naam ?? "").trim().split(/\s+/).slice(-1)[0]);
      const kandidaten = (await zoek("q=" + encodeURIComponent(pc))).filter((z) => {
        const r = (z.recipient ?? {}) as Record<string, unknown>;
        const naam = norm(r.person) + norm(r.company);
        return norm(r.postal_code) === pc && (!achternaam || !naam || naam.includes(achternaam)) && naNaBestelling(z);
      });
      if (kandidaten.length) { id = Number(kandidaten.sort((a, b) => Number(b.id) - Number(a.id))[0].id); herkomst = "postcode"; }
    }
  } catch (e) {
    if ((e as Error).message === "auth") return json(502, { fout: "MyParcel weigert de API-sleutel. Controleer de sleutel in Supabase." });
    return json(502, { fout: "MyParcel is niet bereikbaar. Probeer het zo opnieuw." });
  }

  // 4. Nog geen zending: zelf aanmaken
  if (!id) {
    if (/afhal/i.test(String(best.verzendmethode ?? ""))) {
      return json(400, { fout: `Bestelling #${ordernummer} wordt afgehaald, daar hoort geen verzendlabel bij.` });
    }
    const mp = (best.myparcel ?? {}) as Record<string, any>;
    const o = mp.ontvanger ?? {};
    const opties = mp.bezorgopties ?? {};
    const adres = splitAdres(o.address_1 ?? best.verzend_adres, o.address_2 ?? null);
    if (!adres) return json(400, { fout: `Het adres "${o.address_1 ?? best.verzend_adres}" kon niet in straat en huisnummer worden gesplitst. Maak dit label in MyParcel.` });

    const carrier = VERVOERDERS[String(opties.carrier ?? "postnl").toLowerCase()];
    if (!carrier) return json(400, { fout: `Vervoerder "${opties.carrier}" wordt nog niet ondersteund vanuit het dashboard. Maak dit label in MyParcel.` });
    const bezorg = BEZORGSOORT[String(opties.deliveryType ?? "standard").toLowerCase()] ?? 2;
    const so = opties.shipmentOptions ?? {};
    const gewichtKg = Number(mp.extra?.weight ?? 0);
    const gram = gewichtKg > 0 ? Math.max(1, Math.round(gewichtKg < 50 ? gewichtKg * 1000 : gewichtKg)) : undefined;

    const zending: Record<string, unknown> = {
      reference_identifier: ordernummer,
      carrier,
      recipient: {
        cc: String(o.cc ?? "NL").toUpperCase(),
        street: adres.street,
        number: adres.number,
        ...(adres.number_suffix ? { number_suffix: adres.number_suffix } : {}),
        postal_code: norm(o.postal_code ?? best.verzend_postcode),
        city: o.city ?? best.verzend_plaats,
        person: o.person ?? best.verzend_naam,
        ...(o.company || best.verzend_bedrijf ? { company: o.company ?? best.verzend_bedrijf } : {}),
        ...(o.email || best.email ? { email: o.email ?? best.email } : {}),
        ...(o.phone || best.telefoon ? { phone: o.phone ?? best.telefoon } : {}),
      },
      options: {
        package_type: PAKKETSOORT[String(opties.packageType ?? "package").toLowerCase()] ?? 1,
        delivery_type: bezorg,
        only_recipient: ja(so.only_recipient),
        signature: bezorg === 4 ? 1 : ja(so.signature),
        return: ja(so.return),
        large_format: ja(so.large_format),
        age_check: ja(so.age_check),
        label_description: `#${ordernummer}`,
      },
      ...(gram ? { physical_properties: { weight: gram } } : {}),
    };
    if (bezorg === 4) {
      const p = opties.pickupLocation ?? {};
      if (!p.postal_code && !p.postalCode) return json(400, { fout: `Bestelling #${ordernummer} gaat naar een afhaalpunt, maar dat punt ontbreekt. Maak dit label in MyParcel.` });
      zending.pickup = {
        postal_code: p.postal_code ?? p.postalCode,
        street: p.street,
        number: String(p.number ?? ""),
        city: p.city,
        location_name: p.location_name ?? p.locationName,
        ...(p.location_code ?? p.locationCode ? { location_code: p.location_code ?? p.locationCode } : {}),
        ...(p.retail_network_id ?? p.retailNetworkId ? { retail_network_id: p.retail_network_id ?? p.retailNetworkId } : {}),
      };
    }

    // Claim de bestelling, zodat twee keer klikken geen twee zendingen geeft
    const { data: claim } = await sb.from("bestellingen").update({ myparcel_zending_id: BEZIG })
      .eq("ordernummer", ordernummer).is("myparcel_zending_id", null).select("id");
    if (!claim || !claim.length) return json(409, { fout: "Het label wordt al aangemaakt. Probeer het over een paar seconden opnieuw." });

    const r = await fetch(`${MP}/shipments`, {
      method: "POST",
      headers: { ...mpHeaders, "Content-Type": "application/vnd.shipment+json;version=1.1;charset=utf-8", Accept: "application/json;charset=utf-8" },
      body: JSON.stringify({ data: { shipments: [zending] } }),
    });
    const tekst = await r.text();
    let nieuwId: number | null = null;
    try { nieuwId = Number(JSON.parse(tekst)?.data?.ids?.[0]?.id) || null; } catch (_) { /* geen json */ }
    if (!r.ok || !nieuwId) {
      await sb.from("bestellingen").update({ myparcel_zending_id: null }).eq("ordernummer", ordernummer).eq("myparcel_zending_id", BEZIG);
      console.log("aanmaken mislukt", r.status, tekst.slice(0, 800));
      let reden = "";
      try {
        const e = JSON.parse(tekst);
        reden = (e?.errors ?? []).map((x: any) => x?.human?.[0] ?? x?.message ?? Object.values(x ?? {}).flat().join(" ")).filter(Boolean).join("; ");
      } catch (_) { /* leeg */ }
      return json(502, { fout: `MyParcel kon de zending niet aanmaken${reden ? ": " + reden : ` (code ${r.status})`}. Maak dit label in MyParcel.` });
    }
    id = nieuwId;
    herkomst = "aangemaakt";
  }

  await sb.from("bestellingen").update({ myparcel_zending_id: id }).eq("ordernummer", ordernummer);

  // Label opvragen: hiermee meldt MyParcel de zending aan bij de vervoerder (status concept -> aangemeld)
  const label = await fetch(`${MP}/shipment_labels/${id}?${formaat === "a4" ? "format=A4&positions=1" : "format=A6"}`, {
    headers: { ...mpHeaders, Accept: "application/pdf" },
  });
  if (label.status === 402) return json(402, { fout: "MyParcel wil eerst betaling voor dit label. Rond dat af in MyParcel en probeer het opnieuw." });
  if (!label.ok) {
    console.log("label mislukt", label.status, (await label.text()).slice(0, 500));
    return json(502, { fout: `MyParcel gaf geen label terug (code ${label.status}).` });
  }
  let pdf = new Uint8Array(await label.arrayBuffer());

  // Controleren dat hij echt is aangemeld (barcode) en de barcode opslaan
  const na = await haalZending(id);
  const barcode = String(na?.barcode ?? "").trim();
  console.log("label", JSON.stringify({ ordernummer, id, herkomst, status: na?.status ?? null, barcode: barcode ? "ja" : "nee" }));
  if (!barcode) {
    return json(502, { fout: `MyParcel heeft bestelling #${ordernummer} nog niet aangemeld (geen barcode). Print dit label niet; kijk in MyParcel.` });
  }
  await sb.from("bestellingen").update({ barcode }).eq("ordernummer", ordernummer);

  if (formaat === "rol") {
    try { pdf = await opRol(pdf); } catch (e) { console.log("schalen mislukt, A6 teruggegeven", String(e)); }
  }
  return new Response(pdf, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="label-${ordernummer}.pdf"`,
      "X-Barcode": barcode,
    },
  });
});
