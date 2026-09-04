import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import { Server as SocketServer } from 'socket.io'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import cookieParser from 'cookie-parser'
import { config } from 'dotenv'
import mongoose from 'mongoose'
import { notFound, errorHandler } from './middlewares/errorMiddleware.js'
import authRoutes from './APIS/auth/auth.js'
import customerRoutes from './APIS/customer/index.js'
import sellerRoutes from './APIS/seller/index.js'
import adminRoutes from './APIS/admin/index.js'
import deliveryRoutes from './APIS/delivery/routes.js'
import supportRoutes from './APIS/support/routes.js'
import aiRoutes from './APIS/ai/index.js'

config()

const app = express()
const server = http.createServer(app)
const PORT = parseInt(process.env.PORT, 10) || 3000
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Parse allowed origins from env
const parseOrigins = (raw) =>
	raw ? raw.split(',').map((o) => o.trim()) : ['http://localhost:5173']

const origins = parseOrigins(process.env.CLIENT_URL)

// Socket.io setup
const io = new SocketServer(server, {
	cors: { origin: origins, methods: ['GET', 'POST'], credentials: true },
})

const connectedUsers = new Map()

io.on('connection', (socket) => {
	console.log(`[Socket] Connected: ${socket.id}`)

	socket.on('register', (userId) => {
		if (!userId) return
		socket.userId = userId
		if (!connectedUsers.has(userId)) {
			connectedUsers.set(userId, new Set())
		}
		connectedUsers.get(userId).add(socket.id)
		console.log(`[Socket] User ${userId} registered → ${socket.id}`)
	})

	socket.on('disconnect', () => {
		const sockets = connectedUsers.get(socket.userId)
		if (sockets) {
			sockets.delete(socket.id)
			if (sockets.size === 0) connectedUsers.delete(socket.userId)
		}
		console.log(`[Socket] Disconnected: ${socket.id}`)
	})
})

// Make io and connectedUsers available in routes
app.set('io', io)
app.set('connectedUsers', connectedUsers)

// Global middleware
app.use(helmet())
app.use(cors({ origin: origins, credentials: true }))
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'))
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))
app.use(cookieParser())
// Express 5 leaves req.body undefined when no body-parser matched (e.g. no Content-Type).
// Normalize so every handler can safely destructure req.body.
app.use((req, res, next) => {
	req.body = req.body || {}
	next()
})

// Static files (mock payment gateway page)
app.use(express.static(path.join(__dirname, 'public')))

// API Routes
app.use('/api/auth', authRoutes)
app.use('/api/customer', customerRoutes)
app.use('/api/seller', sellerRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/delivery', deliveryRoutes)
app.use('/api/support', supportRoutes)
app.use('/api/ai', aiRoutes)

// Error handling
app.use(notFound)
app.use(errorHandler)

// Global error listeners
process.on('uncaughtException', (err) => {
	console.error(`[Uncaught] ${err.message}`)
	console.error(err.stack)
	process.exit(1)
})

process.on('unhandledRejection', (reason) => {
	console.error('[Unhandled Rejection]', reason)
})

// Connect to MongoDB then start listening
const connectDB = async () => {
	const uri = process.env.MONGODB_URI || process.env.DB_URL
	if (!uri) {
		console.warn('[DB] No MongoDB URI found in env. Skipping connection.')
		return
	}
	try {
		await mongoose.connect(uri)
		console.log('MongoDB Connected')
	} catch (err) {
		console.error(`[MongoDB] Connection failed: ${err.message}`)
	}
}

const startServer = async () => {
	await connectDB()
	server.listen(PORT, () => {
		console.log(` Server running on port ${PORT}`)
	})
}

if (process.env.NODE_ENV !== 'test') {
	startServer()
}

export { app, startServer, io }
export default app
