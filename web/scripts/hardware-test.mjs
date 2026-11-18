import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const result = spawnSync(process.execPath,
  [require.resolve('@playwright/test/cli'), 'test', '--project=hardware', ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, RUN_USB_PRINT: '1' } });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
