require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const connectDB = require("./config/db");
const authRoutes = require("./routes/authRoutes");
const caseRoutes = require("./routes/caseRoutes");
const adminRoutes = require("./routes/adminRoutes");
const ApiError = require("./utils/ApiError");
const { checkEnv } = require("./config/validateEnv");

// Refuse to start with a missing or (in production) weak JWT_SECRET. Only done
// when the file is run directly, so tests can import the app without it.
const runStartupChecks = () => {
  const { fatal, warnings } = checkEnv(process.env);
  warnings.forEach((message) => console.warn(`[config] ${message}`));
  if (fatal.length) {
    fatal.forEach((message) => console.error(`[config] ${message}`));
    process.exit(1);
  }
};

const app = express();

// Render (and most hosts) sit behind a reverse proxy. Trusting one hop lets
// request.ip, and therefore the login rate limiter, see the real client address.
app.set("trust proxy", 1);

// Configure allowed CORS origins
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable("x-powered-by");

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an Origin header (e.g. native apps and server clients)
      if (
        !origin ||
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin)
      ) {
        return callback(null, true);
      }

      // Allow localhost origins during development only
      if (
        process.env.NODE_ENV !== "production" &&
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        return callback(null, true);
      }

      return callback(new ApiError(403, "Origin not allowed by CORS policy"));
    },
    credentials: true,
  }),
);

// Parse incoming JSON requests
app.use(express.json({ limit: "1mb" }));

// Health-check endpoint for deployment verification
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    database:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/cases", caseRoutes);
app.use("/api/admin", adminRoutes);

// Handle unknown routes
app.use((req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
});

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || 500;
  let message = err.message || "Internal server error";

  if (err.name === "ValidationError") {
    status = 400;
    message = Object.values(err.errors)
      .map((error) => error.message)
      .join(", ");
  } else if (err.code === 11000) {
    status = 409;
    message = "Duplicate value: a record with these details already exists";
  } else if (err.name === "CastError") {
    status = 400;
    message = `Invalid value for ${err.path}`;
  } else if (err.type === "entity.parse.failed") {
    status = 400;
    message = "Malformed JSON in request body";
  }

  if (status >= 500) {
    console.error(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`,
      err,
    );

    if (process.env.NODE_ENV === "production") {
      message = "Internal server error";
    }
  }

  if (res.headersSent) {
    return res.end();
  }

  // `code` is a stable machine-readable reason (e.g. ACCOUNT_PENDING) set via
  // ApiError; `details` carries extra safe fields such as the account status.
  const code = err instanceof ApiError ? err.errorCode : undefined;
  const details = err instanceof ApiError ? err.details : undefined;

  return res.status(status).json({
    success: false,
    message,
    ...(code ? { code } : {}),
    ...(details || {}),
  });
});

// Cloud Run supplies PORT automatically; retain port 5000 for local development
const PORT = process.env.PORT || 5000;
let server;

const start = async () => {
  // Connect to MongoDB before accepting requests
  await connectDB();

  // Listen on all network interfaces for Cloud Run
  server = app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `API listening on port ${PORT} (${process.env.NODE_ENV || "development"})`,
    );
  });
};

// Gracefully shut down the server
const shutdown = (signal) => {
  console.log(`${signal} received, shutting down`);

  if (!server) {
    return process.exit(0);
  }

  return server.close(async () => {
    try {
      await mongoose.connection.close();
    } finally {
      process.exit(0);
    }
  });
};

// `node server.js` (npm start / Render) boots the API. Requiring this file from
// a test only loads the Express app, without connecting or listening.
if (require.main === module) {
  runStartupChecks();

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
  });

  start().catch((err) => {
    console.error("Failed to start server:", err.message);
    process.exit(1);
  });
}

module.exports = app;
