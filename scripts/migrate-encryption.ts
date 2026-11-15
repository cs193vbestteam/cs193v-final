/**
 * One-off: re-encrypts the database in DATABASE_URL with per-user, per-field keys.
 *   npm run migrate:encryption
 * Uses ENCRYPTION_KEY and DATABASE_URL from .env.local (or the environment), so point
 * them at the tier you are migrating. Safe to run more than once.
 */
import { migrateEncryption } from "../src/lib/migrate-encryption";

migrateEncryption()
  .then((counts) => {
    console.log("Re-encrypted rows:", counts);
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      "Migration failed. Rows before the failing one are already migrated; fix the error and run it again:",
      err,
    );
    process.exit(1);
  });
