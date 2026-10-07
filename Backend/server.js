// Load .env FIRST — ESM evaluates imports before any code below runs, so
// modules that read process.env at import time (Cloudinary config, AI
// services, seller wallet, etc.) would otherwise see undefined values.
import 'dotenv/config'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import { Server as SocketServer } from 'socket.io'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import cookieParser from 'cookie-parser'
import mongoose from 'mongoose'
import { notFound, errorHandler } from './middlewares/errorMiddleware.js'
import authRoutes from './APIS/auth/auth.js'
import customerRoutes from './APIS/customer/index.js'
import sellerRoutes from './APIS/seller/index.js'
import adminRoutes from './APIS/admin/index.js'
import deliveryRoutes from './APIS/delivery/routes.js'
import supportRoutes from './APIS/support/routes.js'
import supportNotificationRoutes from './APIS/support/notifications.js'
import aiRoutes from './APIS/ai/index.js'
import setupMessageSocket from './sockets/messages.js'
import setupTicketSocket from './sockets/tickets.js'
import googleSheetsRoutes from "./APIS/googleSheets.js";
import { startSheetSync } from "./services/sheetSync.js";
import { connectDB } from "./config/db.js";
import { autoSeedCategoriesIfEmpty } from "./utils/seedDefaultCategories.js";


const app = express()
app.set('trust proxy', 1)
const server = http.createServer(app)
const PORT = parseInt(process.env.PORT, 10) || 3000
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// Allowed origins list and dynamic matcher for local dev / production
const allowedOrigins = process.env.CLIENT_URL
	? process.env.CLIENT_URL.split(',').map((o) => o.trim())
	: [
			'http://localhost:5173',
			'http://127.0.0.1:5173',
			'http://localhost:5174',
			'http://127.0.0.1:5174',
			'http://localhost:3000',
			'http://127.0.0.1:3000',
	  ]

const isOriginAllowed = (origin) => {
	if (!origin) return true // Allow requests without Origin (curl, server-to-server, postman)
	if (allowedOrigins.includes(origin)) return true
	// Match any localhost, 127.0.0.1, or local LAN IP on any port
	if (/^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin)) {
		return true
	}
	return false
}

const corsOptions = {
	origin: (origin, callback) => {
		if (isOriginAllowed(origin)) {
			callback(null, true)
		} else {
			// Fail-open for local developer convenience
			callback(null, true)
		}
	},
	credentials: true,
	methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
	allowedHeaders: [
		'Content-Type',
		'Authorization',
		'X-Requested-With',
		'Accept',
		'Origin',
		'Access-Control-Request-Method',
		'Access-Control-Request-Headers',
	],
	exposedHeaders: ['Set-Cookie'],
}

// Socket.io setup
const io = new SocketServer(server, {
	cors: {
		origin: (origin, callback) => callback(null, true),
		methods: ['GET', 'POST'],
		credentials: true,
	},
})

app.use("/api/google", googleSheetsRoutes);


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

// Real-time messaging handlers
setupMessageSocket(io, connectedUsers)

// Real-time support-ticket chat (customer ↔ support agent)
setupTicketSocket(io, connectedUsers)

// Global middleware
app.use(
	helmet({
		crossOriginResourcePolicy: { policy: 'cross-origin' },
		crossOriginEmbedderPolicy: false,
	})
)
app.use(cors(corsOptions))
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
app.use('/api/support/notifications', supportNotificationRoutes)
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

const startServer = async () => {
	const dbConnection = await connectDB()
	if (!dbConnection) {
		console.error('[Startup] MongoDB connection failed. Server startup aborted.')
		if (process.env.NODE_ENV !== 'test') {
			process.exit(1)
		}
		return
	}

	// Auto-seed default categories if database has none
	await autoSeedCategoriesIfEmpty()

	// Pull new rows from every seller's Google Sheet into MongoDB every 5 min
	startSheetSync()
	console.log('SheetSync started')

	server.listen(PORT, () => {
		console.log(`Server running on port ${PORT}`)
	})
}

if (process.env.NODE_ENV !== 'test') {
	startServer()
}

export { app, startServer, io }
export default app
