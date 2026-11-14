// Point d'entrée : construit l'application (routes + page) puis écoute.
// Toute la logique HTTP vit dans `src/app.ts` (testable via `app.inject`).
//
// Écoute par DÉFAUT sur la boucle locale (127.0.0.1) : pas de pop-up pare-feu et
// `/admin` n'est pas exposé au réseau local. `HOST=0.0.0.0` permet de l'ouvrir
// explicitement (voir `src/host.ts`).
import { createApp } from './app';
import { resolveHost } from './host';

const port = Number(process.env.PORT ?? 3000);
const host = resolveHost(process.env.HOST);
const app = createApp();

app.listen({ port, host });