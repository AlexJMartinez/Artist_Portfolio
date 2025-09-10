const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ensure uploads subdirs exist
["about", "portfolio", "shop"].forEach((dir) => {
  fs.mkdirSync(path.join(__dirname, "uploads", dir), { recursive: true });
});

// Multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const section = req.params.section || req.path.split("/")[2]; // about/portfolio/shop
    cb(null, path.join(__dirname, "uploads", section));
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// ---- Simple Admin Authentication ---- //
const ADMIN_USER = "Martin3z";
const ADMIN_PASS = "May2nd1989";

function auth(req, res, next) {
  const token = req.headers.authorization;
  if (token === "Bearer valid") return next();
  return res.status(403).json({ error: "Unauthorized" });
}

// ---- ABOUT ---- //
app.post("/upload/about", auth, upload.single("file"), (req, res) => {
  const fileUrl = `/uploads/about/${req.file.filename}`;
  fs.writeFileSync(
    path.join(__dirname, "uploads", "about.json"),
    JSON.stringify({ image: fileUrl }),
  );
  res.json({ success: true, url: fileUrl });
});

app.get("/about-data", (req, res) => {
  const file = path.join(__dirname, "uploads", "about.json");
  if (fs.existsSync(file)) {
    return res.json(JSON.parse(fs.readFileSync(file)));
  }
  res.json({ image: "" });
});

// ---- PORTFOLIO ---- //
const portfolioFile = path.join(__dirname, "uploads", "portfolio.json");

app.post("/upload/portfolio", auth, upload.single("file"), (req, res) => {
  let portfolio = [];
  if (fs.existsSync(portfolioFile))
    portfolio = JSON.parse(fs.readFileSync(portfolioFile));
  const newItem = {
    id: Date.now(),
    url: `/uploads/portfolio/${req.file.filename}`,
  };
  portfolio.push(newItem);
  fs.writeFileSync(portfolioFile, JSON.stringify(portfolio));
  res.json(newItem);
});

app.get("/portfolio-images", (req, res) => {
  if (fs.existsSync(portfolioFile))
    return res.json(JSON.parse(fs.readFileSync(portfolioFile)));
  res.json([]);
});

app.delete("/portfolio/:id", auth, (req, res) => {
  if (!fs.existsSync(portfolioFile)) return res.json([]);
  let portfolio = JSON.parse(fs.readFileSync(portfolioFile));
  portfolio = portfolio.filter((p) => p.id != req.params.id);
  fs.writeFileSync(portfolioFile, JSON.stringify(portfolio));
  res.json({ success: true });
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
app.post("/contact", async (req, res) => {
  const { name, email, message } = req.body;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: "alexjmartinez0502@gmail.com",
      subject: `New Inquiry from ${name}`,
      text: `${message}\n\nFrom: ${name} <${email}>`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Mail error", err);
    res.status(500).json({ success: false, error: "Failed to send email" });
  }
});

// ---- Serve frontend ---- //
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Serve static files from public
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- Start server ---- //
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`),
);
