// Edge Function "medewerker-beheer": alleen voor beheerders. Maakt inlogaccounts voor medewerkers aan,
// wijzigt naam, rol en afdelingen, zet accounts op non-actief en stelt een nieuw wachtwoord in.
// Accounts krijgen een intern e-mailadres (medewerker+naam@graanenzo.nl); daar wordt nooit naartoe gemaild.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const AFDELINGEN = ["winkel", "restaurant", "magazijn"];
const MIN_WACHTWOORD = 8;

function schoneAfdelingen(a: unknown): string[] | null {
  if (!Array.isArray(a) || a.some((x) => !AFDELINGEN.includes(x))) return null;
  return [...new Set(a as string[])];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ fout: "Alleen POST" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ fout: "Niet ingelogd" }, 401);
  const { data: ik } = await admin.from("medewerkers").select("id, rol, actief").eq("user_id", user.id).maybeSingle();
  if (!ik || !ik.actief || ik.rol !== "beheerder") return json({ fout: "Alleen beheerders mogen dit" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ fout: "Ongeldig verzoek" }, 400); }

  if (body.actie === "aanmaken") {
    const naam = String(body.naam ?? "").trim();
    const gebruikersnaam = String(body.gebruikersnaam ?? "").trim().toLowerCase();
    const wachtwoord = String(body.wachtwoord ?? "");
    const rol = body.rol === "beheerder" ? "beheerder" : "medewerker";
    const afdelingen = schoneAfdelingen(body.afdelingen ?? []);
    if (!naam) return json({ fout: "Vul een naam in" }, 400);
    if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(gebruikersnaam)) {
      return json({ fout: "Gebruik voor de inlognaam alleen kleine letters en cijfers, zonder spaties" }, 400);
    }
    if (wachtwoord.length < MIN_WACHTWOORD) return json({ fout: `Het wachtwoord moet minstens ${MIN_WACHTWOORD} tekens hebben` }, 400);
    if (!afdelingen) return json({ fout: "Onbekende afdeling" }, 400);

    const { data: bestaand } = await admin.from("medewerkers").select("id").eq("gebruikersnaam", gebruikersnaam).maybeSingle();
    if (bestaand) return json({ fout: `De inlognaam ${gebruikersnaam} is al in gebruik` }, 409);

    const { data: nieuw, error } = await admin.auth.admin.createUser({
      email: `medewerker+${gebruikersnaam}@graanenzo.nl`, password: wachtwoord, email_confirm: true, user_metadata: { naam },
    });
    if (error || !nieuw.user) return json({ fout: "Account aanmaken mislukt: " + (error?.message ?? "onbekend") }, 400);

    const { data: rij, error: fout } = await admin.from("medewerkers")
      .insert({ user_id: nieuw.user.id, naam, gebruikersnaam, rol, afdelingen }).select().single();
    if (fout) {
      await admin.auth.admin.deleteUser(nieuw.user.id);
      return json({ fout: "Medewerker opslaan mislukt: " + fout.message }, 400);
    }
    return json({ medewerker: rij });
  }

  const id = String(body.id ?? "");
  const { data: doel } = await admin.from("medewerkers").select("*").eq("id", id).maybeSingle();
  if (!doel) return json({ fout: "Medewerker niet gevonden" }, 404);

  if (body.actie === "wijzigen") {
    const velden: Record<string, unknown> = {};
    if (body.naam !== undefined) {
      const naam = String(body.naam).trim();
      if (!naam) return json({ fout: "Vul een naam in" }, 400);
      velden.naam = naam;
    }
    if (body.afdelingen !== undefined) {
      const afdelingen = schoneAfdelingen(body.afdelingen);
      if (!afdelingen) return json({ fout: "Onbekende afdeling" }, 400);
      velden.afdelingen = afdelingen;
    }
    if (body.rol !== undefined) {
      if (body.rol !== "beheerder" && body.rol !== "medewerker") return json({ fout: "Onbekende rol" }, 400);
      velden.rol = body.rol;
    }
    if (body.actief !== undefined) velden.actief = body.actief === true;
    if (doel.id === ik.id && (velden.rol === "medewerker" || velden.actief === false)) {
      return json({ fout: "Je kunt je eigen beheerdersrechten niet uitzetten. Laat een andere beheerder dit doen." }, 400);
    }
    if (velden.actief !== undefined && doel.user_id) {
      const { error } = await admin.auth.admin.updateUserById(doel.user_id, {
        ban_duration: velden.actief ? "none" : "876000h",
      });
      if (error) return json({ fout: "Account bijwerken mislukt: " + error.message }, 400);
    }
    const { data: rij, error } = await admin.from("medewerkers").update(velden).eq("id", id).select().single();
    if (error) return json({ fout: "Opslaan mislukt: " + error.message }, 400);
    return json({ medewerker: rij });
  }

  if (body.actie === "wachtwoord") {
    const wachtwoord = String(body.wachtwoord ?? "");
    if (wachtwoord.length < MIN_WACHTWOORD) return json({ fout: `Het wachtwoord moet minstens ${MIN_WACHTWOORD} tekens hebben` }, 400);
    if (!doel.user_id) return json({ fout: "Deze medewerker heeft geen inlogaccount" }, 400);
    const { error } = await admin.auth.admin.updateUserById(doel.user_id, { password: wachtwoord });
    if (error) return json({ fout: "Wachtwoord instellen mislukt: " + error.message }, 400);
    return json({ ok: true });
  }

  return json({ fout: "Onbekende actie" }, 400);
});
