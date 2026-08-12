import { MongoMemoryServer } from 'mongodb-memory-server';

// Boots ONE mongod for the entire run. Each test file used to boot its own
// (via helpers.ts startDb), which meant 12 sequential mongod boots under
// poolOptions.forks.singleFork — the first test in a file paid that boot cost
// and on a loaded CI runner it occasionally pushed past testTimeout, failing
// tests that had nothing wrong with them. One boot removes that tax.
export default async function setup() {
  const mongod = await MongoMemoryServer.create();
  process.env.TELEMETRY_TEST_MONGO_URI = mongod.getUri();

  return async () => {
    await mongod.stop();
  };
}
