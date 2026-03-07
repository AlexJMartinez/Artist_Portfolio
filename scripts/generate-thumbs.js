const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const portfolioFile = path.join(__dirname, "..", "uploads", "portfolio.json");
const portfolioDir = path.join(__dirname, "..", "uploads", "portfolio");

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function generateThumb(videoPath) {
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

  const g = gcd(width, height);
  const aspectRatio = `${width / g} / ${height / g}`;
  const thumbnailUrl = `/uploads/portfolio/${thumbFilename}`;

  return { thumbnailUrl, aspectRatio };
}

const portfolio = JSON.parse(fs.readFileSync(portfolioFile, "utf8"));
let updated = 0;

for (const item of portfolio) {
  const ext = item.url.split(".").pop().toLowerCase();
  const isVideo = ["mp4", "webm", "ogg", "mov"].includes(ext);
  if (!isVideo) continue;

  if (item.thumbnailUrl && item.aspectRatio) {
    console.log(`Skipping ${item.url} (already has thumbnail)`);
    continue;
  }

  const videoPath = path.join(__dirname, "..", item.url);
  if (!fs.existsSync(videoPath)) {
    console.warn(`File not found: ${videoPath}`);
    continue;
  }

  try {
    const result = generateThumb(videoPath);
    item.thumbnailUrl = result.thumbnailUrl;
    item.aspectRatio = result.aspectRatio;
    console.log(`Generated thumbnail for ${item.url} — ratio: ${result.aspectRatio} → ${result.thumbnailUrl}`);
    updated++;
  } catch (err) {
    console.error(`Failed for ${item.url}:`, err.message);
  }
}

fs.writeFileSync(portfolioFile, JSON.stringify(portfolio, null, 2));
console.log(`\nDone — updated ${updated} video(s).`);
