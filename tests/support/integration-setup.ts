// Integration tests talk to a real PostgreSQL. Point TEST_DATABASE_URL at a
// disposable database; it is exposed to the app code as DATABASE_URL.
const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    "TEST_DATABASE_URL is not set. Example: postgres://test:test@localhost:55432/olympus_main",
  );
}
process.env.DATABASE_URL = url;
process.env.DB_SSL ??= "false";
