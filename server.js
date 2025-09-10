const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure uploads subdirs exist
["about", "portfolio", "shop"].forEach((dir) => {
  fs.mkdirSync(path.join(__dirname, "uploads", dir), { recursive: true });
});

// File validation
const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
const allowedVideoTypes = ['video/mp4', 'video/webm', 'video/ogg', 'video/mov', 'video/quicktime'];
const allowedTypes = [...allowedImageTypes, ...allowedVideoTypes];

const fileFilter = (req, file, cb) => {
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only images and videos are allowed.'), false);
  }
};

// Multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    try {
      const section = req.params.section || req.path.split("/")[2]; // about/portfolio/shop
      if (!['about', 'portfolio', 'shop'].includes(section)) {
        return cb(new Error('Invalid upload section'), null);
      }
      cb(null, path.join(__dirname, "uploads", section));
    } catch (error) {
      cb(error, null);
    }
  },
  filename: function (req, file, cb) {
    try {
      const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
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
    fileSize: 50 * 1024 * 1024, // 50MB limit
  }
});

// ---- JWT Authentication ---- //
// Require environment variables for security
if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}
if (!process.env.ADMIN_PASS_HASH) {
  console.error('FATAL: ADMIN_PASS_HASH environment variable is required');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER || "Martin3z";
const ADMIN_PASS_HASH = process.env.ADMIN_PASS_HASH;

// Authentication middleware
function auth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: "Access token required" });
    }
    
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: "Invalid token" });
    } else if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(500).json({ error: "Authentication error" });
  }
}

// Login endpoint
app.post('/login', [
  body('username').notEmpty().withMessage('Username is required'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
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
    
    const token = jwt.sign(
      { username, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({ token, message: "Login successful" });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---- ABOUT ---- //
app.post("/upload/about", auth, upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    
    const fileUrl = `/uploads/about/${req.file.filename}`;
    const aboutData = { image: fileUrl, uploadedAt: new Date().toISOString() };
    
    fs.writeFileSync(
      path.join(__dirname, "uploads", "about.json"),
      JSON.stringify(aboutData, null, 2),
    );
    
    res.json({ success: true, url: fileUrl });
  } catch (error) {
    console.error('About upload error:', error);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

app.get("/about-data", (req, res) => {
  try {
    const file = path.join(__dirname, "uploads", "about.json");
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, 'utf8');
      const parsedData = JSON.parse(data);
      return res.json(parsedData);
    }
    res.json({ image: "" });
  } catch (error) {
    console.error('About data error:', error);
    res.status(500).json({ error: "Failed to load about data" });
  }
});

// ---- PORTFOLIO ---- //
const portfolioFile = path.join(__dirname, "uploads", "portfolio.json");

app.post("/upload/portfolio", auth, upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    
    let portfolio = [];
    if (fs.existsSync(portfolioFile)) {
      const data = fs.readFileSync(portfolioFile, 'utf8');
      portfolio = JSON.parse(data);
    }
    
    const newItem = {
      id: Date.now(),
      url: `/uploads/portfolio/${req.file.filename}`,
      uploadedAt: new Date().toISOString(),
      fileType: req.file.mimetype
    };
    
    portfolio.push(newItem);
    fs.writeFileSync(portfolioFile, JSON.stringify(portfolio, null, 2));
    
    res.json(newItem);
  } catch (error) {
    console.error('Portfolio upload error:', error);
    res.status(500).json({ error: "Failed to upload portfolio item" });
  }
});

app.get("/portfolio-images", (req, res) => {
  try {
    if (fs.existsSync(portfolioFile)) {
      const data = fs.readFileSync(portfolioFile, 'utf8');
      const portfolio = JSON.parse(data);
      return res.json(portfolio);
    }
    res.json([]);
  } catch (error) {
    console.error('Portfolio images error:', error);
    res.status(500).json({ error: "Failed to load portfolio images" });
  }
});

app.delete("/portfolio/:id", auth, (req, res) => {
  try {
    if (!fs.existsSync(portfolioFile)) {
      return res.json({ success: true, message: "Portfolio file not found" });
    }
    
    const data = fs.readFileSync(portfolioFile, 'utf8');
    let portfolio = JSON.parse(data);
    const itemToDelete = portfolio.find(p => p.id == req.params.id);
    
    if (itemToDelete) {
      // Delete the actual file from filesystem
      const filePath = path.join(__dirname, 'uploads', itemToDelete.url.replace('/uploads/', ''));
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    
    portfolio = portfolio.filter((p) => p.id != req.params.id);
    fs.writeFileSync(portfolioFile, JSON.stringify(portfolio, null, 2));
    
    res.json({ success: true });
  } catch (error) {
    console.error('Portfolio delete error:', error);
    res.status(500).json({ error: "Failed to delete portfolio item" });
  }
});

// // ---- SHOP ---- //
// const shopFile = path.join(__dirname, "uploads", "shop.json");

// app.post("/upload/shop", auth, upload.single("file"), (req, res) => {
//   let shop = [];
//   if (fs.existsSync(shopFile)) shop = JSON.parse(fs.readFileSync(shopFile));
//   const newProduct = {
//     id: Date.now(),
//     title: req.body.title || "Untitled",
//     price: req.body.price || "0",
//     url: `/uploads/shop/${req.file.filename}`,
//   };
//   shop.push(newProduct);
//   fs.writeFileSync(shopFile, JSON.stringify(shop));
//   res.json(newProduct);
// });

// app.get("/shop-products", (req, res) => {
//   if (fs.existsSync(shopFile))
//     return res.json(JSON.parse(fs.readFileSync(shopFile)));
//   res.json([]);
// });

// app.delete("/shop/:id", auth, (req, res) => {
//   if (!fs.existsSync(shopFile)) return res.json([]);
//   let shop = JSON.parse(fs.readFileSync(shopFile));
//   shop = shop.filter((p) => p.id != req.params.id);
//   fs.writeFileSync(shopFile, JSON.stringify(shop));
//   res.json({ success: true });
// });

// ---- CONTACT FORM ---- //
app.post("/contact", [
  body('name').notEmpty().trim().isLength({ min: 2, max: 100 }).withMessage('Name must be 2-100 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('message').notEmpty().trim().isLength({ min: 10, max: 1000 }).withMessage('Message must be 10-1000 characters')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, email, message } = req.body;
    
    // Check if SMTP is configured
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.error('SMTP not configured');
      return res.status(500).json({ success: false, error: "Email service not configured" });
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
        <p>${message.replace(/\n/g, '<br>')}</p>
      `
    });

    res.json({ success: true, message: "Message sent successfully" });
  } catch (err) {
    console.error("Contact form error:", err);
    res.status(500).json({ success: false, error: "Failed to send message. Please try again later." });
  }
});

// ---- Serve frontend ---- //
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Serve static files from public
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Global error handler for multer errors (must be after routes)
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
    }
    return res.status(400).json({ error: 'File upload error: ' + error.message });
  } else if (error) {
    return res.status(400).json({ error: error.message });
  }
  next();
});

// ---- Start server ---- //
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`Server running at http://0.0.0.0:${PORT}`),
);
