// Preloaded (-r) into the update worker run by tests/bridge-rig.ts: stands in for Electron's utility
// process, whose messages to the app are process.parentPort.postMessage.
process.parentPort = { postMessage: (m) => { try { process.send(m); } catch (_) { /* parent gone */ } } };
