// Runs the real customer workflow test (src/workflow.js) against a local StormCheck server.
const { chromium } = require('playwright');
const { runWorkflow } = require('../src/workflow');
runWorkflow({ browserFactory: () => chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] }) })
  .then(r => { console.log(JSON.stringify(r, null, 2)); })
  .catch(e => { console.error(e); process.exit(1); });
