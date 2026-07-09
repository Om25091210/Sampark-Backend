// Loads .env into process.env for tests that use a real database connection
// (e.g. the auth integration suite). Health/schema tests are DB-independent.
import 'dotenv/config';
