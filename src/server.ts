// Point d'entrée : construit l'application (routes + page) puis écoute.
// Toute la logique HTTP vit dans `src/app.ts` (testable via `app.inject`).
import { createApp } from './app';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

app.listen({ port, host: '0.0.0.0' });
