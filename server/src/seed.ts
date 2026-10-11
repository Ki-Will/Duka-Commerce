/**
 * DukaCommerce demo/UAT seed CLI.
 * Run: npm run seed   (idempotent — skips if stores already exist)
 * All passwords are documented test values: "password123"
 */
import { createContext } from './context.js';
import { seedIfEmpty } from './seedData.js';

const ctx = createContext({ file: process.env.DUKA_DB_FILE ?? 'duka.sqlite' });
const seeded = seedIfEmpty(ctx);

if (!seeded) {
  console.log('Seed skipped: stores already exist. Delete duka.sqlite to reseed.');
} else {
  console.log('Seed complete.');
  console.log('Test accounts (password: password123):');
  console.log('  customer1@test.com  customer2@test.com');
  console.log('  merchant1@test.com (Kigali Home)  merchant2@test.com (Imbere Fashion)  merchant3@test.com (Tech Corner)');
  console.log('  staff1@test.com (staff @ Kigali Home)');
  console.log('  support@test.com  admin@test.com');
}
ctx.close();
