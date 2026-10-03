const express = require("express");
const server = express();
const mongoose = require("mongoose");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");
const { imageSize } = require("image-size");
require("dotenv").config();

// Trust reverse proxy (e.g. Render, Railway, Nginx) for accurate client IP in rate limiting
server.set("trust proxy", 1);

// --- Config ---
const COLLECTION_NAME =
  process.env.WORKSHOP_COLLECTION || "aiAgentsToolsWorkshopUsers";
const TEMPLATE_PATH = path.join(
  __dirname,
  "assets",
  "CertificateTemplate.png"
);

// Read template dimensions at startup (avoids re-reading on every request)
const templateBuffer = fs.readFileSync(TEMPLATE_PATH);
const templateDimensions = imageSize(templateBuffer);
const TEMPLATE_W = templateDimensions.width;
const TEMPLATE_H = templateDimensions.height;
console.log(`Certificate template loaded: ${TEMPLATE_W}x${TEMPLATE_H}`);

// --- Middleware ---
server.use(express.json({ limit: "10kb" }));

// Restrict CORS to ALLOWED_ORIGIN if set, default to same-origin only
if (process.env.ALLOWED_ORIGIN) {
  server.use(
    cors({
      origin: process.env.ALLOWED_ORIGIN,
      credentials: true,
    })
  );
}

// Rate limiter: default max 150 requests per IP per 15 minutes for certificate generation.
// Students in a workshop share one college IP (campus Wi-Fi/NAT), so the limit must stay generous.
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 150;

const certificateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  statusCode: 429,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
});

// --- Database ---
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    console.log("database connected");
  } catch (error) {
    console.error("database connection error:", error);
  }
};
connectDB();

// --- Schema & Model ---
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 50,
    },
    college: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      maxlength: 100,
    },
    course: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 50,
    },
    mobile: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: /^[6-9]\d{9}$/,
    },
    semester: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
      validate: {
        validator: Number.isInteger,
        message: "Semester must be an integer.",
      },
    },
  },
  {
    timestamps: true,
  }
);

const UserModel = mongoose.model(
  "AiAgentsToolsWorkshopUser",
  userSchema,
  COLLECTION_NAME
);

// --- Validation ---
const FIELD_RULES = [
  {
    field: "name",
    regex: /^[A-Za-z][A-Za-z .'-]{2,49}$/,
    message:
      "Name must be 3–50 characters using Latin letters, spaces, dots, hyphens, or apostrophes only.",
  },
  {
    field: "college",
    regex: /^[A-Za-z0-9][A-Za-z0-9 .,&()'\/-]{2,99}$/,
    message:
      "College must be 3–100 characters, starting with a letter or digit.",
  },
  {
    field: "course",
    regex: /^[A-Za-z][A-Za-z0-9 .()&+\/-]{1,49}$/,
    message: "Course must be 2–50 characters, starting with a letter.",
  },
  {
    field: "mobile",
    regex: /^[6-9]\d{9}$/,
    message:
      "Mobile must be a valid 10-digit Indian number starting with 6–9 (no +91).",
  },
  {
    field: "semester",
    regex: /^([1-9]|1[0-2])$/,
    message: "Semester must be a whole number between 1 and 12.",
  },
];

/**
 * Coerce to string, collapse repeated whitespace, trim.
 * Prevents NoSQL injection via object payloads like { "$ne": null }.
 */
function sanitize(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Convert a string to Title Case (first letter of each word uppercase). */
function toTitleCase(str) {
  return str.toLowerCase().replace(/(?:^|\s)\S/g, (ch) => ch.toUpperCase());
}

// --- Static files (only public/ is served) ---
server.use(express.static(path.join(__dirname, "public")));

server.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Certificate endpoint ---
server.post("/get-certificate", certificateLimiter, async (req, res) => {
  try {
    // 1. Sanitize every incoming field to a plain string
    const data = {};
    for (const key of ["name", "college", "course", "mobile", "semester"]) {
      data[key] = sanitize(req.body[key]);
    }

    // 2. Validate against regex rules (first failing field wins)
    for (const rule of FIELD_RULES) {
      if (!rule.regex.test(data[rule.field])) {
        return res.status(400).json({ success: false, message: rule.message });
      }
    }

    // 3. Title-case the name and parse semester to integer
    data.name = toTitleCase(data.name);
    data.semester = parseInt(data.semester, 10);

    // 4. Upsert: one record per mobile number (repeat submission updates)
    let user;
    try {
      user = await UserModel.findOneAndUpdate(
        { mobile: data.mobile },
        data,
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        }
      );
    } catch (err) {
      // Retry once on duplicate-key race condition (code 11000)
      if (err.code === 11000) {
        user = await UserModel.findOneAndUpdate(
          { mobile: data.mobile },
          data,
          {
            upsert: true,
            new: true,
            runValidators: true,
            setDefaultsOnInsert: true,
          }
        );
      } else {
        throw err;
      }
    }

    // 5. Set response headers for PDF download
    res.setHeader(
      "Content-disposition",
      "attachment; filename=certificate.pdf"
    );
    res.setHeader("Content-type", "application/pdf");
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    // 6. Generate the certificate PDF
    const doc = new PDFDocument({
      size: [TEMPLATE_W, TEMPLATE_H],
      margin: 0,
    });
    doc.pipe(res);

    // Draw template background at full size
    doc.image(TEMPLATE_PATH, 0, 0, {
      width: TEMPLATE_W,
      height: TEMPLATE_H,
    });

    // Draw the student's name centred above the signature line
    const nameText = data.name;
    const LINE_Y = 1165; // y-coordinate of the signature line on the template
    const NAME_X = 591; // left edge of the name region
    const NAME_WIDTH = 1515; // width of the name region (2106 - 591)
    const MAX_TEXT_WIDTH = 1400; // maximum rendered text width before shrinking

    doc.font("Times-Bold");
    let fontSize = 80;
    doc.fontSize(fontSize);
    while (doc.widthOfString(nameText) > MAX_TEXT_WIDTH && fontSize > 44) {
      fontSize -= 2;
      doc.fontSize(fontSize);
    }

    // Position the text so its baseline sits ~25 px above the line
    const nameY = LINE_Y - 25 - fontSize * 0.9;

    doc.fillColor("#062622").text(nameText, NAME_X, nameY, {
      width: NAME_WIDTH,
      align: "center",
    });

    // Finalize the PDF and end the stream
    doc.end();
  } catch (error) {
    console.error("Certificate generation error:", error);
    if (!res.headersSent) {
      res
        .status(500)
        .json({
          success: false,
          message: "Something went wrong. Please try again.",
        });
    } else {
      console.error("Error occurred after headers sent:", error.message);
      res.end();
    }
  }
});

// Catch-all 404 route — must be after all other routes
server.get("/*", (req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "Error.html"));
});

server.listen(process.env.PORT || 8000, () => {
  console.log("server running");
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Rejection:", err);
});
