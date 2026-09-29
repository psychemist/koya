/**
 * Integration tests run against a real database, because the constraints are
 * the thing under test. A mocked create_support_ticket would happily accept a
 * duplicate, which is exactly the bug the partial unique index exists to make
 * impossible.
 *
 * TEST_DATABASE_URL, when set, wins over DATABASE_URL. It is assigned here, at
 * import, before lib/db.ts creates its pool on the first query.
 */
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

export const skipWithoutDatabase = !process.env.DATABASE_URL;
