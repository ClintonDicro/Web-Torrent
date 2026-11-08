// Starts one local WSS tracker for the whole run and exposes its URL to the tests.
import { startTracker } from '../support/tracker.mjs'

export default async function globalSetup () {
  const tracker = await startTracker()
  process.env.TEST_TRACKER = tracker.url
  return async () => { await tracker.close() }
}
