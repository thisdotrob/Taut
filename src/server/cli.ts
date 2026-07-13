import './env';
import { clearDemoData, migrate, seedDemoData } from './db';
import { ingestSlack } from './slack';

migrate();
const command = process.argv[2];

if (command === 'seed') {
  seedDemoData();
  console.log('Seeded demo data.');
} else if (command === 'clear-demo') {
  const result = clearDemoData();
  console.log(`Cleared ${result.itemsDeleted} demo items and ${result.conversationsDeleted} demo conversations.`);
} else if (command === 'ingest') {
  const result = await ingestSlack(5);
  console.log(JSON.stringify(result, null, 2));
} else {
  console.error('Usage: pnpm seed | pnpm clear-demo | pnpm ingest');
  process.exit(1);
}
