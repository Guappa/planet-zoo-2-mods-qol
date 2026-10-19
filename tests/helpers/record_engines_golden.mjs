// node tests/helpers/record_engines_golden.mjs  (only from the pre-Autopilot code)
import { writeFileSync } from 'node:fs';
import { digestAll } from './enginedigest.mjs';
writeFileSync(new URL('../fixtures/engines_golden.json', import.meta.url), JSON.stringify(digestAll()));
console.log('recorded');
