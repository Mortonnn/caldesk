const { app } = require('electron')
console.log('BOOT')
try {
  const s = require('node:sqlite')
  console.log('sqlite OK, DatabaseSync =', typeof s.DatabaseSync)
} catch (e) {
  console.log('sqlite FAIL:', e.message)
}
app.whenReady().then(() => { console.log('READY'); setTimeout(() => app.exit(0), 200) })
