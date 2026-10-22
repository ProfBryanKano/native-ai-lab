// Prepare the mounted data directory, then drop root before starting HTTP.
// Build-time chown alone does not affect a newly mounted persistent disk.
import { mkdirSync, chownSync } from 'node:fs';
import { dirname } from 'node:path';
import { startServer } from './server.mjs';

const directory = dirname(process.env.DATABASE_PATH || '/var/data/accord.sqlite');
mkdirSync(directory, { recursive: true });
if (process.getuid?.() === 0) {
  chownSync(directory, 1000, 1000);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
startServer();
