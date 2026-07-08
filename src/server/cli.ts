import { migrate, seedDemoData } from './db';
import { ingestSlack } from './slack';

migrate();
const command = process.argv[2];

if (command === 'seed') {
  seedDemoData();
  console.log('Seeded demo data.');
} else if (command === 'ingest') {
  const result = await ingestSlack(10);
  console.log(JSON.stringify(result, null, 2));
} else {
  console.error('Usage: pnpm seed | pnpm ingest');
  process.exit(1);
}
