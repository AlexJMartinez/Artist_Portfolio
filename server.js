const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
const { Pool } = require("pg");
const crypto = require("crypto");
const compression = require("compression");
const sanitizeHtml = require("sanitize-html");
const sharp = require("sharp");
const { execSync } = require("child_process");
// Using Node.js built-in fetch (Node 18+) instead of node-fetch for ESM compatibility
require("dotenv").config();

// Set default values for missing environment variables
process.env.PORT = process.env.PORT || "5000";
process.env.NODE_ENV = process.env.NODE_ENV || "production";

// Environment validation for deployment
function validateEnvironment() {
  const warnings = [];
  const errors = [];

  // Check critical environment variables
  if (!process.env.DATABASE_URL) {
    warnings.push("DATABASE_URL not set - database features will be limited");
  }

  if (!process.env.REPL_IDENTITY && !process.env.WEB_REPL_RENEWAL) {
    warnings.push(
      "No email authentication tokens found - email features will be limited",
    );
  }

  // Log warnings and errors
  if (warnings.length > 0) {
    console.warn("⚠️  Environment Configuration Warnings:");
    warnings.forEach((warning) => console.warn(`  - ${warning}`));
  }

  if (errors.length > 0) {
    console.error("❌ Environment Configuration Errors:");
    errors.forEach((error) => console.error(`  - ${error}`));
    console.error("Please fix these configuration issues before deployment.");
  }

  return { warnings, errors, hasErrors: errors.length > 0 };
}

// Run environment validation
const envValidation = validateEnvironment();

// Utility function to generate secure unsubscribe tokens
function generateUnsubscribeToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Utility function to build URLs based on request
function buildBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host =
    req.headers.host || req.headers["x-forwarded-host"] || "localhost:5000";
  return `${protocol}://${host}`;
}

// Database setup with error handling
let pool;
try {
  if (!process.env.DATABASE_URL) {
    console.warn("DATABASE_URL not set - database features will be disabled");
    pool = null;
  } else {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });

    // Test the connection on startup
    pool.on("error", (err) => {
      console.error("Database connection error:", err);
    });

    // Attempt initial connection test (non-blocking)
    pool
      .connect()
      .then((client) => {
        console.log("Database connected successfully");
        client.release();
      })
      .catch((err) => {
        console.error("Database connection failed on startup:", err);
        console.warn("Database features will be limited");
      });
  }
} catch (error) {
  console.error("Error setting up database pool:", error);
  console.warn("Database features will be disabled");
  pool = null;
}

// Replit Mail utility function (using official integration pattern)
async function sendEmail(message) {
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    console.warn(
      "No authentication token found for email service. Email functionality will be limited.",
    );
    // Return a mock success response instead of throwing error to prevent startup failure
    return {
      success: false,
      error: "Email service not configured",
      mock: true,
    };
  }

  try {
    const response = await fetch(
      "https://connectors.replit.com/api/v2/mailer/send",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          X_REPLIT_TOKEN: xReplitToken,
        },
        body: JSON.stringify({
          to: message.to,
          cc: message.cc,
          subject: message.subject,
          text: message.text,
          html: message.html,
          attachments: message.attachments,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      console.error("Replit Mail API error:", response.status, error);
      throw new Error(error.message || "Failed to send email");
    }

    return await response.json();
  } catch (error) {
    console.error("SendEmail error:", error);
    throw error;
  }
}

const app = express();

// Add cache control for static assets to improve performance
app.use('/uploads', (req, res, next) => {
  res.set('Cache-Control', 'public, max-age=31536000'); // 1 year for uploaded images
  next();
});

// Disable caching for the main HTML and API responses to prevent replit iframe caching issues
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.startsWith('/api') || req.path === '/portfolio-images' || req.path === '/about' || req.path === '/about-data' || req.path === '/development-videos') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

app.use(compression()); // Enable gzip compression
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure uploads subdirs exist
["about", "portfolio", "shop"].forEach((dir) => {
  fs.mkdirSync(path.join(__dirname, "uploads", dir), { recursive: true });
});

// File validation
const allowedImageTypes = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
];
const allowedVideoTypes = [
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/mov",
  "video/quicktime",
];
const allowedTypes = [...allowedImageTypes, ...allowedVideoTypes];

const fileFilter = (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error("Invalid file type. Only images and videos are allowed."),
      false,
    );
  }
};

// Compress uploaded images in-place using sharp
async function compressImage(filePath, mimetype) {
  if (!mimetype || !mimetype.startsWith("image/")) return;
  try {
    const tmp = filePath + ".tmp";
    await sharp(filePath)
      .resize({ width: 1400, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(tmp);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    console.error("Image compression failed:", err.message);
    // Non-fatal: keep original file if compression fails
  }
}

// Detect an image's aspect ratio (as a "W / H" CSS ratio string) so the
// frontend can reserve correct space for lazy-loaded images before they
// finish downloading, avoiding masonry column-balance glitches.
async function getImageAspectRatio(filePath) {
  try {
    const metadata = await sharp(filePath).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (!width || !height) return null;
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const g = gcd(width, height);
    return `${width / g} / ${height / g}`;
  } catch (err) {
    console.error("Image aspect ratio detection failed:", err.message);
    return null;
  }
}

// Extract first frame thumbnail and dimensions from a video file using ffmpeg/ffprobe
async function generateVideoThumbnail(videoPath) {
  try {
    const dir = path.dirname(videoPath);
    const baseName = path.basename(videoPath, path.extname(videoPath));
    const thumbFilename = `thumb_${baseName}.jpg`;
    const thumbPath = path.join(dir, thumbFilename);

    execSync(
      `ffmpeg -y -ss 0 -i "${videoPath}" -frames:v 1 -q:v 2 "${thumbPath}"`,
      { stdio: "pipe" }
    );

    const probeOutput = execSync(
      `ffprobe -v quiet -print_format json -show_streams "${videoPath}"`,
      { encoding: "utf8" }
    );
    const probe = JSON.parse(probeOutput);
    const videoStream = probe.streams.find((s) => s.codec_type === "video");
    const width = videoStream?.width || 16;
    const height = videoStream?.height || 9;

    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const g = gcd(width, height);
    const aspectRatio = `${width / g} / ${height / g}`;

    const uploadsDir = path.join(__dirname, "uploads");
    const thumbnailUrl = `/uploads/${path.relative(uploadsDir, thumbPath)}`;

    return { thumbnailUrl, aspectRatio };
  } catch (err) {
    console.error("Thumbnail generation failed:", err.message);
    return null;
  }
}

// Multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    try {
      const section = req.params.section || req.path.split("/")[2]; // about/portfolio/shop
      if (!["about", "portfolio", "shop"].includes(section)) {
        return cb(new Error("Invalid upload section"), null);
      }
      cb(null, path.join(__dirname, "uploads", section));
    } catch (error) {
      cb(error, null);
    }
  },
  filename: function (req, file, cb) {
    try {
      const uniqueName =
        Date.now() +
        "-" +
        Math.round(Math.random() * 1e9) +
        path.extname(file.originalname);
      cb(null, uniqueName);
    } catch (error) {
      cb(error, null);
    }
  },
});

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB - more reasonable limit
  },
});

// ---- JWT Authentication ---- //
// Require environment variables for security
if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET environment variable is required");
  process.exit(1);
}
if (!process.env.ADMIN_PASS_HASH) {
  console.error("FATAL: ADMIN_PASS_HASH environment variable is required");
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER || "Martin3z";
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH;

// Authentication middleware
function auth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Access token required" });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    } else if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(500).json({ error: "Authentication error" });
  }
}

// Health check endpoint for Cloud Run deployment
app.get("/health", (req, res) => {
  try {
    // Check if critical services are available
    const healthStatus = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: pool ? "connected" : "unavailable",
      environment: process.env.NODE_ENV || "development"
    };
    
    // Return 200 OK with health information
    res.status(200).json(healthStatus);
  } catch (error) {
    console.error("Health check error:", error);
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      error: "Service unavailable"
    });
  }
});

// Login endpoint
app.post(
  "/login",
  [
    body("username").notEmpty().withMessage("Username is required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { username, password } = req.body;

      if (username !== ADMIN_USER) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const isValidPassword = await bcrypt.compare(password, ADMIN_PASS_HASH);
      if (!isValidPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const token = jwt.sign({ username, role: "admin" }, JWT_SECRET, {
        expiresIn: "24h",
      });

      res.json({ token, message: "Login successful" });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---- ABOUT ---- //
app.post("/upload/about", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = path.join(__dirname, "uploads", "about", req.file.filename);
    await compressImage(filePath, req.file.mimetype);

    const fileUrl = `/uploads/about/${req.file.filename}`;
    const aboutData = { image: fileUrl, uploadedAt: new Date().toISOString() };

    fs.writeFileSync(
      path.join(__dirname, "uploads", "about.json"),
      JSON.stringify(aboutData, null, 2),
    );

    res.json({ success: true, url: fileUrl });
  } catch (error) {
    console.error("About upload error:", error);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

app.get("/about-data", (req, res) => {
  try {
    const file = path.join(__dirname, "uploads", "about.json");
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, "utf8");
      const parsedData = JSON.parse(data);
      return res.json(parsedData);
    }
    res.json({ image: "" });
  } catch (error) {
    console.error("About data error:", error);
    res.status(500).json({ error: "Failed to load about data" });
  }
});

// ---- PORTFOLIO ---- //
const portfolioFile = path.join(__dirname, "uploads", "portfolio.json");

app.post("/upload/portfolio", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    let portfolio = [];
    if (fs.existsSync(portfolioFile)) {
      const data = fs.readFileSync(portfolioFile, "utf8");
      portfolio = JSON.parse(data);
    }

    // Compress image uploads in-place before saving metadata
    const filePath = path.join(__dirname, "uploads", "portfolio", req.file.filename);
    await compressImage(filePath, req.file.mimetype);

    // For video uploads, extract first-frame thumbnail and detect aspect ratio.
    // For image uploads, detect aspect ratio so the frontend can reserve
    // correct masonry grid space before the lazy-loaded image finishes downloading.
    const isVideoUpload = req.file.mimetype && req.file.mimetype.startsWith("video/");
    let thumbnailUrl = null;
    let aspectRatio = null;
    if (isVideoUpload) {
      const thumbResult = await generateVideoThumbnail(filePath);
      if (thumbResult) {
        thumbnailUrl = thumbResult.thumbnailUrl;
        aspectRatio = thumbResult.aspectRatio;
      }
    } else {
      aspectRatio = await getImageAspectRatio(filePath);
    }

    const rawCategory = req.body.category || "";
    const category = ["photography", "audio-visual", "painting"].includes(rawCategory)
      ? rawCategory
      : "photography";

    const newItem = {
      id: Date.now(),
      url: `/uploads/portfolio/${req.file.filename}`,
      uploadedAt: new Date().toISOString(),
      fileType: req.file.mimetype,
      caption: "",
      category,
      ...(thumbnailUrl && { thumbnailUrl }),
      ...(aspectRatio && { aspectRatio }),
    };

    portfolio.push(newItem);
    fs.writeFileSync(portfolioFile, JSON.stringify(portfolio, null, 2));

    // Send notification emails to all active subscribers
    try {
      // Skip email notifications if database is unavailable
      if (!pool) {
        console.warn(
          "Database unavailable - skipping email notifications for new portfolio item",
        );
        return res.json({
          success: true,
          message: "Portfolio item uploaded successfully",
        });
      }

      const subscribers = await pool.query(
        "SELECT name, email, unsubscribe_token FROM subscribers WHERE is_active = true",
      );

      if (subscribers.rows.length > 0) {
        // Determine if it's an image or video for the notification
        const isVideo = req.file.mimetype.startsWith("video/");
        const artworkType = isVideo ? "video artwork" : "artwork";

        // Get base URL for this request
        const baseUrl = buildBaseUrl(req);

        // Send notification to all subscribers
        const emailPromises = subscribers.rows.map(async (subscriber) => {
          try {
            // Get unsubscribe token for this subscriber
            const unsubscribeData = await pool.query(
              "SELECT unsubscribe_token FROM subscribers WHERE email = $1",
              [subscriber.email],
            );

            const unsubscribeToken = unsubscribeData.rows[0]?.unsubscribe_token;
            const unsubscribeUrl = unsubscribeToken
              ? `${baseUrl}/unsubscribe?token=${unsubscribeToken}`
              : "#";

            await sendEmail({
              to: subscriber.email,
              subject: "🎨 New Artwork Added to Alex Martínez Portfolio!",
              text: `Hi ${subscriber.name}!\n\nI've just added a new ${artworkType} to my portfolio. Check it out and see what I've been working on lately!\n\nView the latest work: ${baseUrl}\n\nYou can unsubscribe at any time: ${unsubscribeUrl}\n\nBest regards,\nAlex Martínez`,
              html: `
                <h2>🎨 New Artwork Added!</h2>
                <p>Hi ${subscriber.name}!</p>
                <p>I've just added a new <strong>${artworkType}</strong> to my portfolio. Check it out and see what I've been working on lately!</p>
                <p style="text-align: center; margin: 30px 0;">
                  <a href="${baseUrl}" 
                     style="background: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                    View Latest Work
                  </a>
                </p>
                <p>Thank you for following my artistic journey!</p>
                <p>Best regards,<br>Alex Martínez</p>
                <hr>
                <p style="font-size: 12px; color: #666;">
                  <a href="${unsubscribeUrl}" style="color: #666;">Unsubscribe from these emails</a>
                </p>
              `,
            });
          } catch (emailError) {
            console.error(
              `Failed to send notification to ${subscriber.email}:`,
              emailError,
            );
          }
        });

        await Promise.allSettled(emailPromises);
        console.log(
          `Portfolio notification sent to ${subscribers.rows.length} subscribers`,
        );
      }
    } catch (notificationError) {
      console.error(
        "Failed to send portfolio notifications:",
        notificationError,
      );
      // Don't fail the upload if notification fails
    }

    res.json(newItem);
  } catch (error) {
    console.error("Portfolio upload error:", error);
    res.status(500).json({ error: "Failed to upload portfolio item" });
  }
});

app.get("/portfolio-images", (req, res) => {
  try {
    if (fs.existsSync(portfolioFile)) {
      const data = fs.readFileSync(portfolioFile, "utf8");
      const portfolio = JSON.parse(data);
      return res.json(portfolio);
    }
    res.json([]);
  } catch (error) {
    console.error("Portfolio images error:", error);
    res.status(500).json({ error: "Failed to load portfolio images" });
  }
});

// Update portfolio caption
app.patch(
  "/portfolio/:id/caption",
  auth,
  [
    body("caption")
      .isString()
      .isLength({ max: 500 })
      .withMessage("Caption must be a string with maximum 500 characters"),
  ],
  (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      if (!fs.existsSync(portfolioFile)) {
        return res.status(404).json({ error: "Portfolio file not found" });
      }

      const portfolio = JSON.parse(fs.readFileSync(portfolioFile, "utf8"));
      const itemIndex = portfolio.findIndex(
        (item) => item.id === parseInt(req.params.id),
      );

      if (itemIndex === -1) {
        return res.status(404).json({ error: "Portfolio item not found" });
      }

      // Sanitize caption to prevent XSS
      const sanitizedCaption = sanitizeHtml(req.body.caption.trim(), {
        allowedTags: [], // No HTML tags allowed
        allowedAttributes: {},
      });

      portfolio[itemIndex].caption = sanitizedCaption;
      fs.writeFileSync(portfolioFile, JSON.stringify(portfolio, null, 2));

      res.json({
        success: true,
        message: "Caption updated successfully",
        caption: sanitizedCaption,
      });
    } catch (error) {
      console.error("Caption update error:", error);
      res.status(500).json({ error: "Failed to update caption" });
    }
  },
);

// Update portfolio item category
app.patch("/portfolio/:id/category", auth, (req, res) => {
  try {
    const rawCategory = req.body.category || "";
    const category = ["photography", "audio-visual", "painting"].includes(rawCategory)
      ? rawCategory
      : null;
    if (!category) {
      return res.status(400).json({ error: "Invalid category" });
    }
    if (!fs.existsSync(portfolioFile)) {
      return res.status(404).json({ error: "Portfolio file not found" });
    }
    const portfolio = JSON.parse(fs.readFileSync(portfolioFile, "utf8"));
    const itemIndex = portfolio.findIndex(
      (item) => item.id === parseInt(req.params.id),
    );
    if (itemIndex === -1) {
      return res.status(404).json({ error: "Portfolio item not found" });
    }
    portfolio[itemIndex].category = category;
    fs.writeFileSync(portfolioFile, JSON.stringify(portfolio, null, 2));
    res.json({ success: true, category });
  } catch (error) {
    console.error("Category update error:", error);
    res.status(500).json({ error: "Failed to update category" });
  }
});

app.delete("/portfolio/:id", auth, (req, res) => {
  try {
    if (!fs.existsSync(portfolioFile)) {
      return res.json({ success: true, message: "Portfolio file not found" });
    }

    const data = fs.readFileSync(portfolioFile, "utf8");
    let portfolio = JSON.parse(data);
    const itemToDelete = portfolio.find((p) => p.id == req.params.id);

    if (itemToDelete) {
      // Delete the actual file from filesystem
      const filePath = path.join(
        __dirname,
        "uploads",
        itemToDelete.url.replace("/uploads/", ""),
      );
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    portfolio = portfolio.filter((p) => p.id != req.params.id);
    fs.writeFileSync(portfolioFile, JSON.stringify(portfolio, null, 2));

    res.json({ success: true });
  } catch (error) {
    console.error("Portfolio delete error:", error);
    res.status(500).json({ error: "Failed to delete portfolio item" });
  }
});

// ---- DEVELOPMENT VIDEOS (YouTube links) ---- //
const developmentFile = path.join(__dirname, "uploads", "development.json");

function extractYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

app.get("/development-videos", (req, res) => {
  try {
    if (fs.existsSync(developmentFile)) {
      const data = fs.readFileSync(developmentFile, "utf8");
      return res.json(JSON.parse(data));
    }
    res.json([]);
  } catch (err) {
    console.error("Development videos error:", err);
    res.status(500).json({ error: "Failed to load development videos" });
  }
});

app.post("/development-videos", auth, (req, res) => {
  try {
    const { youtubeUrl, title, description } = req.body;
    if (!youtubeUrl) {
      return res.status(400).json({ error: "youtubeUrl is required" });
    }
    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      return res.status(400).json({ error: "Invalid YouTube URL" });
    }
    if (description && description.length > 500) {
      return res.status(400).json({ error: "Description must be 500 characters or fewer" });
    }

    let items = [];
    if (fs.existsSync(developmentFile)) {
      items = JSON.parse(fs.readFileSync(developmentFile, "utf8"));
    }

    const newItem = {
      id: Date.now(),
      videoId,
      youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
      title: (title || "").trim(),
      description: (description || "").trim(),
      addedAt: new Date().toISOString(),
    };

    items.push(newItem);
    fs.writeFileSync(developmentFile, JSON.stringify(items, null, 2));
    res.json({ success: true, item: newItem });
  } catch (err) {
    console.error("Development video add error:", err);
    res.status(500).json({ error: "Failed to add development video" });
  }
});

app.delete("/development-videos/:id", auth, (req, res) => {
  try {
    if (!fs.existsSync(developmentFile)) {
      return res.json({ success: true });
    }
    let items = JSON.parse(fs.readFileSync(developmentFile, "utf8"));
    items = items.filter((item) => item.id != req.params.id);
    fs.writeFileSync(developmentFile, JSON.stringify(items, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error("Development video delete error:", err);
    res.status(500).json({ error: "Failed to delete development video" });
  }
});

// ---- CONTACT FORM ---- //
app.post(
  "/contact",
  [
    body("name")
      .notEmpty()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage("Name must be 2-100 characters"),
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email is required"),
    body("message")
      .notEmpty()
      .trim()
      .isLength({ min: 10, max: 1000 })
      .withMessage("Message must be 10-1000 characters"),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { name, email, message } = req.body;

      // Check if SMTP is configured
      if (
        !process.env.SMTP_HOST ||
        !process.env.SMTP_USER ||
        !process.env.SMTP_PASS
      ) {
        console.warn(
          "SMTP not configured - contact form submission logged but email not sent",
        );
        // Log the contact form submission for manual review
        console.log("Contact form submission (SMTP not configured):", {
          name: name,
          email: email,
          message: message,
          timestamp: new Date().toISOString(),
        });
        // Return success with notification about email service
        return res.json({
          success: true,
          message: "Message received successfully. We'll get back to you soon!",
          note: "Email service temporarily unavailable",
        });
      }

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        secure: false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });

      await transporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.CONTACT_EMAIL || "alexjmartinez0502@gmail.com",
        subject: `New Inquiry from ${name}`,
        text: `${message}\n\nFrom: ${name} <${email}>`,
        html: `
        <h3>New Contact Form Submission</h3>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Message:</strong></p>
        <p>${message.replace(/\n/g, "<br>")}</p>
      `,
      });

      res.json({ success: true, message: "Message sent successfully" });
    } catch (err) {
      console.error("Contact form error:", err);
      res.status(500).json({
        success: false,
        error: "Failed to send message. Please try again later.",
      });
    }
  },
);

// ---- SUBSCRIBE ENDPOINT ---- //
app.post(
  "/subscribe",
  [
    body("name")
      .notEmpty()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage("Name must be 2-100 characters"),
    body("email")
      .isEmail()
      .normalizeEmail()
      .withMessage("Valid email is required"),
  ],
  async (req, res) => {
    try {
      // Check if database is available
      if (!pool) {
        return res.status(503).json({
          success: false,
          error:
            "Database service is currently unavailable. Please try again later.",
        });
      }

      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      const { name, email } = req.body;

      // Check if email already exists
      const existingSubscriber = await pool.query(
        "SELECT * FROM subscribers WHERE email = $1",
        [email],
      );

      let isNewSubscriber = false;
      if (existingSubscriber.rows.length > 0) {
        if (existingSubscriber.rows[0].is_active) {
          return res.status(400).json({
            success: false,
            error: "You are already subscribed to updates!",
          });
        } else {
          // Reactivate existing subscriber
          await pool.query(
            "UPDATE subscribers SET is_active = true, subscribed_at = CURRENT_TIMESTAMP WHERE email = $1",
            [email],
          );
          isNewSubscriber = false;
        }
      } else {
        // Add new subscriber with unsubscribe token
        const unsubscribeToken = generateUnsubscribeToken();
        await pool.query(
          "INSERT INTO subscribers (name, email, unsubscribe_token) VALUES ($1, $2, $3)",
          [name, email, unsubscribeToken],
        );
        isNewSubscriber = true;
      }

      // Only send welcome email to new subscribers, not reactivated ones
      if (isNewSubscriber) {
        // Get the subscriber with unsubscribe token for welcome email
        const subscriberData = await pool.query(
          "SELECT unsubscribe_token FROM subscribers WHERE email = $1",
          [email],
        );

        const unsubscribeToken = subscriberData.rows[0]?.unsubscribe_token;
        const baseUrl = buildBaseUrl(req);
        const unsubscribeUrl = `${baseUrl}/unsubscribe?token=${unsubscribeToken}`;

        // Send welcome email using Replit Mail
        try {
          await sendEmail({
            to: email,
            subject: "Welcome to Alex Martínez Portfolio Updates!",
            text: `Hi ${name}!\n\nThank you for subscribing to my portfolio updates. You'll be the first to know when I add new artwork to my collection.\n\nYou can unsubscribe at any time: ${unsubscribeUrl}\n\nBest regards,\nAlex Martínez`,
            html: `
              <h2>Welcome to Alex Martínez Portfolio Updates!</h2>
              <p>Hi ${name}!</p>
              <p>Thank you for subscribing to my portfolio updates. You'll be the first to know when I add new artwork to my collection.</p>
              <p>Stay tuned for exciting new creative works!</p>
              <p>Best regards,<br>Alex Martínez</p>
              <hr>
              <p style="font-size: 12px; color: #666;">
                <a href="${unsubscribeUrl}" style="color: #666;">Unsubscribe from these emails</a>
              </p>
            `,
          });
        } catch (emailError) {
          console.error("Failed to send welcome email:", emailError);
          // Don't fail the subscription if email fails
        }
      }

      res.json({
        success: true,
        message:
          "Successfully subscribed! Check your email for a welcome message.",
      });
    } catch (err) {
      console.error("Subscribe error:", err);
      res.status(500).json({
        success: false,
        error: "Failed to subscribe. Please try again later.",
      });
    }
  },
);

// ---- UNSUBSCRIBE ENDPOINT ---- //
app.get("/unsubscribe", async (req, res) => {
  try {
    // Check if database is available
    if (!pool) {
      return res.status(503).send(`
        <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
          <h2 style="color: #dc3545;">Service Temporarily Unavailable</h2>
          <p>The unsubscribe service is currently unavailable. Please try again later.</p>
          <p>If this problem persists, please contact us directly.</p>
        </body></html>
      `);
    }

    const { token } = req.query;

    if (!token) {
      return res.status(400).send(`
        <html><body>
          <h2>Invalid Unsubscribe Link</h2>
          <p>The unsubscribe link appears to be invalid or incomplete.</p>
        </body></html>
      `);
    }

    // Find subscriber by token and deactivate
    const result = await pool.query(
      "UPDATE subscribers SET is_active = false WHERE unsubscribe_token = $1 AND is_active = true RETURNING name, email",
      [token],
    );

    if (result.rows.length === 0) {
      return res.status(404).send(`
        <html><body>
          <h2>Unsubscribe Link Not Found</h2>
          <p>This unsubscribe link is either invalid or you may already be unsubscribed.</p>
        </body></html>
      `);
    }

    const subscriber = result.rows[0];
    console.log(`Successfully unsubscribed: ${subscriber.email}`);

    res.send(`
      <html><body style="font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px;">
        <h2 style="color: #28a745;">✓ Successfully Unsubscribed</h2>
        <p>Hi ${subscriber.name},</p>
        <p>You have been successfully unsubscribed from Alex Martínez Portfolio updates.</p>
        <p>You will no longer receive email notifications about new artwork.</p>
        <p>If you change your mind, you can always subscribe again on our website.</p>
        <p>Best regards,<br>Alex Martínez</p>
      </body></html>
    `);
  } catch (error) {
    console.error("Unsubscribe error:", error);
    res.status(500).send(`
      <html><body>
        <h2>Error</h2>
        <p>There was an error processing your unsubscribe request. Please try again later or contact support.</p>
      </body></html>
    `);
  }
});

// ---- Serve frontend ---- //
// Serve uploads with aggressive caching since filenames are unique
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    maxAge: "1y", // Cache for 1 year
    etag: true,
    setHeaders: (res, path) => {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    },
  }),
);

// Serve static files from public with caching.
// index: false — prevents express.static from auto-serving index.html for "/"
// so the named SSR route handlers below can inject per-route head tags instead.
app.use(
  express.static(path.join(__dirname, "public"), {
    index: false,
    maxAge: "1d", // Cache for 1 day
    etag: true,
    setHeaders: (res, filePath) => {
      // Never cache HTML — always serve fresh so CSS/JS changes reach users immediately
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
      }
      // Cache uploaded files for longer since they have unique names
      if (filePath.includes("/uploads/")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // 1 year
      }
    },
  }),
);

// ── SSR: head tags + body content for crawlers ──────────────────────────────
// Social/AI crawlers (Facebook, Twitter, GPTBot, ClaudeBot, PerplexityBot,
// etc.) don't execute JavaScript, so they'd see a blank page.  We fix this by:
//   1. Injecting route-specific <title>, <meta description>, og:*, twitter:*,
//      and <link rel="canonical"> into the <head> server-side.
//   2. Pre-rendering meaningful semantic body content for each route so that
//      crawlers can read and index the page even without JavaScript.
// The SPA JS still hydrates/overwrites <main id="content"> after it loads,
// so interactive behaviour is unchanged for real users.

const SPA_SHELL = fs.readFileSync(
  path.join(__dirname, "public", "index.html"),
  "utf8",
);

// Shared HTML-escape helper (used in both head and body rendering)
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Read a JSON data file safely; returns [] or {} on failure
function readJson(relPath, fallback = []) {
  try {
    const abs = path.join(__dirname, relPath);
    if (!fs.existsSync(abs)) return fallback;
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return fallback;
  }
}

// Default OG image (about photo — works for every route)
const DEFAULT_OG_IMG_PATH = "/uploads/about/1757387371946.JPG";

const PAGE_META = {
  home: {
    title: "Alex Martínez – Artist | Minimalist Abstract Expression",
    description:
      "The portfolio of Alex Martínez — Creative Technologist, Mixed Multimedia Artist, Painter, and Photographer exploring Abstract, Generative Art, and Immersive Experiences.",
  },
  portfolio: {
    title: "Portfolio – Alex Martínez | Photography, Painting & Audio Visual",
    description:
      "Browse Alex Martínez's portfolio of Photography, Painting, and Audio Visual work — a curated collection of Abstract and Mixed Multimedia Art.",
    ogImgPath: "/uploads/portfolio/1757007912549.JPG",
  },
  about: {
    title: "About – Alex Martínez | Creative Technologist & Artist",
    description:
      "Learn about Alex Martínez — Creative Technologist, Creative Coder, and Mixed Multimedia Artist driven by the intersection of technology and abstract expression.",
  },
  development: {
    title: "Development – Alex Martínez | Creative Coding & Generative Art",
    description:
      "Explore Alex Martínez's development work — Creative Coding, Generative Art, and immersive audio-visual experiments at the intersection of code and art.",
  },
  contact: {
    title: "Contact – Alex Martínez",
    description:
      "Get in touch with Alex Martínez — Creative Technologist and Mixed Multimedia Artist.",
  },
};

// Build the full SSR <head> block for a given route
function ssrHead(route, baseUrl) {
  const m = PAGE_META[route] || PAGE_META.home;
  const canonicalPath = route === "home" ? "/" : `/${route}`;
  const ogImg = `${baseUrl}${m.ogImgPath || DEFAULT_OG_IMG_PATH}`;
  const ogUrl = `${baseUrl}${canonicalPath}`;
  return `<title>${esc(m.title)}</title>
    <meta name="description" content="${esc(m.description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Alex Martínez" />
    <meta property="og:title" content="${esc(m.title)}" />
    <meta property="og:description" content="${esc(m.description)}" />
    <meta property="og:image" content="${esc(ogImg)}" />
    <meta property="og:url" content="${esc(ogUrl)}" />
    <meta property="og:locale" content="en_US" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(m.title)}" />
    <meta name="twitter:description" content="${esc(m.description)}" />
    <meta name="twitter:image" content="${esc(ogImg)}" />
    <link rel="canonical" href="${esc(ogUrl)}" />
    <script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Person",
          "@id": `${baseUrl}/#person`,
          "name": "Alex Martínez",
          "url": `${baseUrl}/`,
          "sameAs": [
            "https://instagram.com/debtfortunes",
            "https://www.linkedin.com/in/alexanderjustinmartinez/",
            "https://github.com/AlexJMartinez"
          ],
          "jobTitle": "Multidisciplinary Artist",
          "description": "Minimalist abstract expressionist working in photography, audio-visual, and painting.",
          "knowsAbout": [
            "Abstract Art",
            "Generative Art",
            "Creative Coding",
            "Immersive Art",
            "Photography",
            "Painting",
            "Audio Visual"
          ]
        },
        {
          "@type": "WebSite",
          "@id": `${baseUrl}/#website`,
          "url": `${baseUrl}/`,
          "name": "Alex Martínez – Artist",
          "description": "Portfolio of Alex Martínez — Creative Technologist and Mixed Multimedia Artist.",
          "publisher": { "@id": `${baseUrl}/#person` },
          "inLanguage": "en-US"
        },
        {
          "@type": "WebPage",
          "@id": `${ogUrl}#webpage`,
          "url": ogUrl,
          "name": m.title,
          "description": m.description,
          "isPartOf": { "@id": `${baseUrl}/#website` },
          "about": { "@id": `${baseUrl}/#person` },
          "inLanguage": "en-US"
        }
      ]
    })}</script>`;
}

// Build semantic body HTML for each route so crawlers can read real content.
// JS will replace this with the interactive version after it loads.
function ssrBody(route, baseUrl) {
  switch (route) {
    case "home":
      return `<section class="hero">
        <h1>Alex Martínez</h1>
        <p>Minimalist Abstract Expression — Creative Technologist, Mixed Multimedia Artist, Painter &amp; Photographer.</p>
        <nav aria-label="Social links">
          <a href="https://instagram.com/debtfortunes" rel="noopener" aria-label="Instagram">Instagram</a>
          <a href="https://www.linkedin.com/in/alexanderjustinmartinez/" rel="noopener" aria-label="LinkedIn">LinkedIn</a>
          <a href="https://github.com/AlexJMartinez" rel="noopener" aria-label="GitHub">GitHub</a>
        </nav>
      </section>`;

    case "portfolio": {
      const items = readJson("uploads/portfolio.json", []);
      const categories = [
        { key: "photography", label: "Photography" },
        { key: "audio-visual", label: "Audio Visual" },
        { key: "painting", label: "Painting" },
      ];
      const sections = categories
        .map(({ key, label }) => {
          const group = items.filter(
            (i) => (i.category || "photography") === key,
          );
          if (group.length === 0) return `<section><h2>${label}</h2><p>No items yet.</p></section>`;
          const imgs = group
            .map((item) => {
              const src = `${baseUrl}${item.url}`;
              const alt = esc(item.caption || label + " artwork by Alex Martínez");
              return `<figure><img src="${esc(src)}" alt="${alt}" loading="lazy" /></figure>`;
            })
            .join("\n");
          return `<section>\n<h2>${label}</h2>\n${imgs}\n</section>`;
        })
        .join("\n");
      return `<div class="portfolio-wrapper">${sections}</div>`;
    }

    case "about": {
      const aboutData = readJson("uploads/about.json", {});
      const imgHtml = aboutData.image
        ? `<img src="${esc(baseUrl + aboutData.image)}" alt="Alex Martínez" />`
        : "";
      return `<section class="about">
        ${imgHtml}
        <div class="about-text">
          <h2>About The Artist</h2>
          <p>"It's no measure of health to be well adjusted to a profoundly sick society" — Jiddu Krishnamurti</p>
          <h3>Debt Fortunes</h3>
          <p>Modern economies thrive on leverage. Governments issue bonds, corporations finance expansion with loans, and households use credit to buy homes, cars, and education. Debt is often the engine of fortune creation — fueling innovation, infrastructure, and consumerism.</p>
          <p>But debt isn't neutral. For poorer nations, "Debt Fortunes" often means dependence on richer creditors — through IMF or World Bank loans that come with structural conditions. This creates a cycle where fortunes in the Global North are sustained by perpetual repayment burdens in the Global South.</p>
          <p>In many cultures, debt carries stigma, while in others it's normalized — even celebrated as part of the "American Dream." This cultural acceptance turns debt into a status signal: mortgages imply ownership, venture debt implies ambition.</p>
          <p>Debt magnifies fortunes but also magnifies collapses. The 2008 financial crisis showed how debt-fueled housing markets could create immense wealth for some and destroy lives for others.</p>
          <p>On a societal level, "Debt Fortunes" reflects how humanity has tethered its sense of progress to a future that doesn't yet exist. Fortune, then, isn't about what we own now, but about the gamble that tomorrow will let us pay for today's ambition.</p>
        </div>
      </section>`;
    }

    case "development": {
      const videos = readJson("uploads/development.json", []);
      if (videos.length === 0) {
        return `<section><h2>Development</h2><p>Creative Coding, Generative Art, and immersive audio-visual experiments. No videos yet.</p></section>`;
      }
      const rows = videos
        .map((v) => {
          const title = esc(v.title || "Untitled Project");
          const desc = esc(
            v.description ||
              "An in-progress look at one of the current development projects.",
          );
          const ytUrl = `https://www.youtube.com/watch?v=${esc(v.videoId)}`;
          return `<article>
            <h3>${title}</h3>
            <p>${desc}</p>
            <a href="${ytUrl}" rel="noopener">Watch on YouTube</a>
          </article>`;
        })
        .join("\n");
      return `<section class="portfolio-wrapper dev-wrapper">
        <h2>Development</h2>
        <p>Creative Coding, Generative Art, and immersive audio-visual experiments. Also available via <a href="https://ohseven.gumroad.com/" rel="noopener">ohseven.gumroad.com</a>.</p>
        ${rows}
      </section>`;
    }

    case "contact":
      return `<div class="contact-container">
        <div class="contact-card">
          <h2>Contact</h2>
          <p>Get in touch with Alex Martínez — Creative Technologist and Mixed Multimedia Artist.</p>
          <p>Email: <a href="mailto:alexjmartinez0502@gmail.com">alexjmartinez0502@gmail.com</a></p>
          <form id="contactForm" method="post" action="/contact">
            <input type="text" name="name" placeholder="Your name" />
            <input type="email" name="email" placeholder="Your email" />
            <textarea name="message" placeholder="Message"></textarea>
            <button type="submit">Send</button>
          </form>
        </div>
      </div>`;

    default:
      return ssrBody("home", baseUrl);
  }
}

function buildSpaHtml(route, req) {
  const baseUrl = buildBaseUrl(req);
  const head = ssrHead(route, baseUrl);
  const body = ssrBody(route, baseUrl);
  return SPA_SHELL
    .replace("<title>Alex Martínez – Artist</title>", head)
    .replace('<main id="content"></main>', `<main id="content">${body}</main>`);
}

function serveSpa(route) {
  return (req, res) => {
    res.set("Cache-Control", "no-store, must-revalidate");
    res.type("html").send(buildSpaHtml(route, req));
  };
}

const KNOWN_PAGES = ["portfolio", "about", "development", "contact"];
app.get("/", serveSpa("home"));
app.get("/home", (req, res) => res.redirect(301, "/"));
KNOWN_PAGES.forEach((page) => app.get(`/${page}`, serveSpa(page)));

// Catch-all: unknown paths fall back to the home shell
app.get("*", (req, res) => {
  res.set("Cache-Control", "no-store, must-revalidate");
  res.type("html").send(buildSpaHtml("home", req));
});

// Global error handler for multer errors (must be after routes)
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ error: "File too large. Maximum size is 1GB." });
    }
    return res
      .status(400)
      .json({ error: "File upload error: " + error.message });
  } else if (error) {
    return res.status(400).json({ error: error.message });
  }
  next();
});

// ---- Start server ---- //
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running at http://0.0.0.0:${PORT}`),
);
