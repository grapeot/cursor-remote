import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createCursorGateway } from './cursorAgent.js';
import { InMemoryEventBroker } from './eventBroker.js';
import { InMemoryEventStore } from './eventStore.js';
import { InMemoryProjectionStore } from './projectionStore.js';
import { RunService } from './runService.js';
import { SessionService } from './sessionService.js';

const config = loadConfig();
const gateway = createCursorGateway(config);
const eventStore = new InMemoryEventStore();
const projectionStore = new InMemoryProjectionStore();
const eventBroker = new InMemoryEventBroker(eventStore);
const sessionService = new SessionService(config, eventStore, projectionStore, eventBroker);
const runService = new RunService(config, gateway, eventStore, projectionStore, eventBroker);
const app = createApp(config, gateway, { eventStore, projectionStore, eventBroker, sessionService, runService });

app.listen(config.port, () => {
  console.log(`Cursor Remote API listening on http://localhost:${config.port}`);
});
