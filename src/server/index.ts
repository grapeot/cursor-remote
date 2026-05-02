import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createCursorGateway } from './cursorAgent.js';

const config = loadConfig();
const app = createApp(config, createCursorGateway(config));

app.listen(config.port, () => {
  console.log(`Cursor Cloud Remote POC API listening on http://localhost:${config.port}`);
});
