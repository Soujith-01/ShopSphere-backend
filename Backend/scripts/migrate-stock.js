import 'dotenv/config'
import mongoose from 'mongoose'
import Product from '../models/Product.js'

const run = async () => {
  const uri = process.env.MONGODB_URI || process.env.DB_URL
  if (!uri) {
    console.error('No MongoDB URI found in env')
    process.exit(1)
  }

  await mongoose.connect(uri)
  console.log('Connected to MongoDB')

  // Find products where stock is undefined or null
  const res = await Product.updateMany(
    { $or: [{ stock: { $exists: false } }, { stock: null }] },
    { $set: { stock: 25 } }
  )

  console.log(`Updated ${res.modifiedCount} legacy product(s) with default stock = 25`)
  await mongoose.disconnect()
  process.exit(0)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
