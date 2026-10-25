/**
 * DukaCommerce demo/UAT seed CLI.
 * Run: npm run seed   (idempotent — skips if stores already exist)
 * Targets the same backend as the server: Neon Postgres when DATABASE_URL
 * is set (.env.local), otherwise the local SQLite file.
 * All passwords are documented test values: "password123"
 */
import { loadEnv } from './env.js';
import { createContext } from './context.js';
import { seedIfEmpty } from './seedData.js';

loadEnv();

async function main(): Promise<void> {
  const ctx = createContext();
  try {
    const seeded = await seedIfEmpty(ctx);
    console.log(`Database: ${ctx.db.driver}`);
    if (!seeded) {
      console.log('Seed skipped: stores already exist.');
    } else {
      console.log('Seed complete.');
      console.log('Test accounts (password: password123):');
      console.log('  customer1@test.com  customer2@test.com');
      console.log('  merchant1@test.com (Kigali Home)  merchant2@test.com (Imbere Fashion)  merchant3@test.com (Tech Corner)');
      console.log('  staff1@test.com (staff @ Kigali Home)');
      console.log('  support@test.com  admin@test.com');
    }
  } finally {
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
