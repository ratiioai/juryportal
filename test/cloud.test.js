// Exercise the actual asynchronous libSQL driver against a disposable file database.
// Network credentials and live Turso latency still require a deployment rehearsal.
process.env.JURY_TEST_MODE = 'cloud';
require('./portal.test');
