import dns from 'dns'
import mongoose from 'mongoose'

// Configure safe DNS resolution fallback for MongoDB Atlas SRV lookups
function setupDns() {
  try {
    const currentServers = dns.getServers()
    // If only loopback (127.0.0.1) or empty, configure public DNS servers
    const isLoopbackOnly =
      !currentServers ||
      currentServers.length === 0 ||
      (currentServers.length === 1 && currentServers[0].startsWith('127.'))

    if (isLoopbackOnly) {
      dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1'])
    }
  } catch {
    // If setServers fails in restrictive environments, continue gracefully
  }

  try {
    if (typeof dns.setDefaultResultOrder === 'function') {
      dns.setDefaultResultOrder('ipv4first')
    }
  } catch {
    // Ignore if not supported
  }
}

/**
 * Safely mask sensitive credentials from connection strings for logging
 */
export function maskUri(uri) {
  if (!uri || typeof uri !== 'string') return '[empty]'
  return uri.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@')
}

/**
 * Analyze and categorize MongoDB connection errors for clear diagnostic output
 */
export function diagnoseMongoError(err, uri) {
  const message = err?.message || String(err)
  const masked = maskUri(uri)

  console.error('\n═══════════════════════════════════════════════════════════════')
  console.error(' [MongoDB Diagnostics]')
  console.error(` Target URI: ${masked}`)

  if (message.includes('querySrv') || err?.code === 'ECONNREFUSED' || err?.code === 'ENOTFOUND') {
    console.error(' Reason: [DNS / SRV Resolution Failure]')
    console.error(' Details: Node.js could not resolve the MongoDB Atlas SRV record.')
    console.error(' Recommendation:')
    console.error('   1. Check your local DNS or network firewall settings.')
    console.error('   2. Alternatively, configure standard replica-set URI (mongodb://...) in MONGODB_URI.')
  } else if (
    err?.name === 'MongoServerError' &&
    (err?.code === 18 || message.toLowerCase().includes('auth') || message.toLowerCase().includes('bad auth'))
  ) {
    console.error(' Reason: [Authentication Failure]')
    console.error(' Details: Database username or password in MONGODB_URI is invalid.')
    console.error(' Recommendation:')
    console.error('   1. Check Database Access in MongoDB Atlas dashboard.')
    console.error('   2. Ensure the user exists and the password in .env is correct.')
  } else if (
    err?.name === 'MongooseServerSelectionError' ||
    message.includes('Could not connect to any servers') ||
    message.includes('ETIMEDOUT') ||
    message.includes('Server selection timed out')
  ) {
    console.error(' Reason: [Atlas Network Access / IP Whitelist or Unreachable Cluster]')
    console.error(' Details: Connection timed out reaching MongoDB Atlas shard hosts on port 27017.')
    console.error(' Recommendation:')
    console.error('   1. Go to MongoDB Atlas (cloud.mongodb.com) -> Security -> Network Access.')
    console.error('   2. Add your current IP address (or 0.0.0.0/0 to allow all origins).')
    console.error('   3. Ensure the Atlas cluster is active and not paused.')
  } else {
    console.error(` Reason: [Connection Error: ${err?.name || 'Unknown'}]`)
    console.error(` Details: ${message}`)
  }
  console.error('═══════════════════════════════════════════════════════════════\n')
}

/**
 * Connect to MongoDB with retry logic, DNS fallback, and error handling.
 * Returns mongoose.connection on success, or null on failure.
 */
export async function connectDB(options = {}) {
  const maxRetries = options.maxRetries ?? 3
  const retryDelayMs = options.retryDelayMs ?? 2000
  const uri = process.env.MONGODB_URI || process.env.DB_URL

  if (!uri) {
    console.error('[MongoDB] No MONGODB_URI or DB_URL found in environment variables.')
    return null
  }

  // Setup DNS resolvers first
  setupDns()

  const mongooseOptions = {
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    family: 4,
    ...options.mongooseOptions,
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // If previous attempt had DNS issues, force fallback public DNS
      if (attempt > 1) {
        try {
          dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1'])
        } catch {}
      }

      await mongoose.connect(uri, mongooseOptions)
      console.log('MongoDB connected successfully')
      return mongoose.connection
    } catch (err) {
      console.error(`[MongoDB] Connection attempt ${attempt}/${maxRetries} failed: ${err.message}`)

      if (attempt < maxRetries) {
        console.log(`[MongoDB] Retrying connection in ${retryDelayMs / 1000}s...`)
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      } else {
        diagnoseMongoError(err, uri)
      }
    }
  }

  return null
}

export default connectDB
