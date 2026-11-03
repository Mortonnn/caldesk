const fs = require('fs')
const p = 'src/main/index.ts'
let s = fs.readFileSync(p, 'utf8')
const before = "import { loadSyncConfig, saveSyncConfig, syncNow } from './sync'"
const after = [
  "import {",
  '  approveDevice,',
  '  createAccount,',
  '  listDevices,',
  '  listPendingDevices,',
  '  rejectDevice,',
  '  revokeDevice,',
  '  startPairing,',
  '  syncNow',
  "} from './sync'",
  "import { ensureIdentity, isPaired, saveIdentity, type StoredIdentity } from './identity'",
  "import { newAccountKey } from './crypto'",
  "import { pairingQrText } from '@shared/identity'"
].join('\n')
if (!s.includes(before)) {
  console.error('anchor not found')
  process.exit(1)
}
s = s.replace(before, after)
fs.writeFileSync(p, s)
console.log('imports patched')
