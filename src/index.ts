/**
 * Entry point
 *
 * Starts the WhatsApp invoice backend application.
 */
import { loadConfig } from './config/index.js';
import { Application } from './app.js';

async function main(): Promise<void> {
  // Load and validate configuration (fails fast on invalid config)
  loadConfig();

  const app = new Application();
  await app.start();
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
