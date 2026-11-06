# Graan & Zo dashboard

Interne browser-app voor Graan & Zo (magazijn, winkel, restaurant), gekoppeld aan Supabase (project *graanenzo-app*), WooCommerce en MyParcel.

- `verpakken.html` – de hele app in één bestand.
- `planning.html` – personeelsplanning: rooster, beschikbaarheid, in- en uitklokken en urenoverzicht. Accountbeheer loopt via Edge Function `medewerker-beheer`.
- `supabase/functions/woocommerce-sync` – haalt elke 5 minuten betaalde webbestellingen op.
- `supabase/functions/myparcel-status` – neemt elke 15 minuten de status van zendingen over uit MyParcel.
- `supabase/functions/myparcel-label` – maakt het verzendlabel en koppelt de zending aan de order in MyParcel.
