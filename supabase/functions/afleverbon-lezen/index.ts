// Leest een foto (of gescande pagina) van een Odin-afleverbon met Claude en
// geeft de regels terug in dezelfde vorm als de PDF-lezer in het dashboard.
// Geheim: ANTHROPIC_API_KEY. Optioneel: ANTHROPIC_MODEL.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROMPT = `Dit is een foto van een afleverbon van groothandel Odin (Nederlands). Lees ALLE artikelregels, ook op meerdere foto's (pagina's).

Kolommen op de bon: Artnr. | Omschrijving | Leverancier (merk) | KM | Lnd | KL | Geleverd | Netto gew. | SVE | Ink wrde sve | Ink wrde eenh | Adv prijs eenh | marge % | Regel bedrag.
Voorbeeld van een regel: "28310 APPELSAP NIEUWE BAND BIO-DEM DE 1,0 12 FLESSEN a 200 ML 11,71 0,98 1,59 33,1 % 11,71"
- artnr = 28310, omschrijving = "APPELSAP", merk = "NIEUWE BAND", km = "BIO-DEM"
- colli = 1 (kolom Geleverd: aantal dozen), per_colli = 12, verpakking = "FLESSEN", inhoud = 200, inhoud_eenheid = "ML"
- ink_colli = 11.71, ink_stuk = 0.98, advies_stuk = 1.59, bedrag = 11.71
Regels waarvan het artikelnummer met * begint (kratten, rolcontainer, stopkosten) zijn kosten: zet kosten = true.
Bij "1 STUK a 25 KILO": per_colli = 1, verpakking = "STUK", inhoud = 25, inhoud_eenheid = "KILO".
Noteer ook per regel het ordernummer (regel "Ordernr.: 3771695") en de afleverdatum bovenaan.

Antwoord ALLEEN met JSON, zonder uitleg, in deze vorm:
{"afleverdatum":"JJJJ-MM-DD","orders":["3771694"],"regels":[{"ordernr":"3771694","artnr":"28310","kosten":false,"omschrijving":"APPELSAP","merk":"NIEUWE BAND","km":"BIO-DEM","colli":1,"per_colli":12,"verpakking":"FLESSEN","inhoud":200,"inhoud_eenheid":"ML","ink_colli":11.71,"ink_stuk":0.98,"advies_stuk":1.59,"bedrag":11.71}]}
Getallen met een punt als decimaalteken. Onleesbaar getal: null. Sla geen regels over en verzin niets.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  try {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) return json({ fout: "Foto's lezen is nog niet ingesteld (ANTHROPIC_API_KEY ontbreekt in Supabase)." }, 500);
    const { afbeeldingen } = await req.json();
    if (!Array.isArray(afbeeldingen) || !afbeeldingen.length) return json({ fout: "Geen foto ontvangen" }, 400);
    if (afbeeldingen.length > 8) return json({ fout: "Maximaal 8 foto's tegelijk" }, 400);

    const content = [
      ...afbeeldingen.map((a: { type?: string; data: string }) => ({
        type: "image",
        source: { type: "base64", media_type: a.type || "image/jpeg", data: a.data },
      })),
      { type: "text", text: PROMPT },
    ];
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
        max_tokens: 16000,
        messages: [{ role: "user", content }],
      }),
    });
    const antwoord = await r.json();
    if (!r.ok) return json({ fout: "Tekstherkenning gaf een fout: " + (antwoord?.error?.message || r.status) }, 502);
    const tekst = (antwoord.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
    const m = tekst.match(/\{[\s\S]*\}/);
    if (!m) return json({ fout: "De bon kon niet gelezen worden" }, 422);
    const bon = JSON.parse(m[0]);
    return json({ afleverdatum: bon.afleverdatum ?? null, orders: bon.orders ?? [], regels: bon.regels ?? [] });
  } catch (e) {
    return json({ fout: String((e as Error).message || e) }, 500);
  }
});
