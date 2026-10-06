import 'dotenv/config'
import { connectDB } from '../config/db.js'
import Store from '../models/Store.js'

async function healStores() {
  await connectDB()
  const sheetId = process.env.GOOGLE_SPREADSHEET_ID || '19Mxj2xBBfUDo1Kd1BJmy7frN_mDi9QnyPvIJ7IBX1nk'
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`

  const stores = await Store.find({})
  console.log(`Found ${stores.length} stores to check.`)

  for (const store of stores) {
    if (!store.googleSheet?.spreadsheetId || !store.googleSheet?.spreadsheetUrl) {
      store.googleSheet = {
        spreadsheetId: store.googleSheet?.spreadsheetId || sheetId,
        spreadsheetUrl: store.googleSheet?.spreadsheetUrl || sheetUrl,
        sharedWith: store.googleSheet?.sharedWith || '',
      }
      await store.save()
      console.log(`✅ Updated store "${store.name}" (${store._id}) with Google Sheet: ${sheetUrl}`)
    } else {
      console.log(`ℹ️ Store "${store.name}" already has sheet: ${store.googleSheet.spreadsheetUrl}`)
    }
  }

  process.exit(0)
}

healStores().catch((err) => {
  console.error('Failed to heal stores:', err)
  process.exit(1)
})
