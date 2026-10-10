/**
 * Entry point — starts the FUSION ONE backend application.
 */
import { loadConfig } from './config/index.js';
import { Application } from './app.js';

async function main(): Promise<void> {
  loadConfig(); // fails fast on invalid config

  const app = new Application();
  await app.start();
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
