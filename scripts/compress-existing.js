const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const targets = [
  "uploads/portfolio/1757007912549.JPG",
  "uploads/portfolio/1757007881532.JPG",
  "uploads/portfolio/1757354881131.jpg",
  "uploads/portfolio/1757012387941.jpg",
];

async function compressFile(filePath) {
  const abs = path.join(__dirname, "..", filePath);
  if (!fs.existsSync(abs)) {
    console.log(`Skipping (not found): ${filePath}`);
    return;
  }
  const before = fs.statSync(abs).size;
  const tmp = abs + ".tmp";
  try {
    await sharp(abs)
      .resize({ width: 1400, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toFile(tmp);
    fs.renameSync(tmp, abs);
    const after = fs.statSync(abs).size;
    const saved = (((before - after) / before) * 100).toFixed(1);
    console.log(
      `${path.basename(filePath)}: ${(before / 1024 / 1024).toFixed(1)}MB → ${(after / 1024).toFixed(0)}KB (${saved}% smaller)`
    );
  } catch (err) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    console.error(`Failed ${filePath}:`, err.message);
  }
}

(async () => {
  console.log("Compressing existing large images...\n");
  for (const f of targets) {
    await compressFile(f);
  }
  console.log("\nDone.");
})();
