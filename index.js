const express = require("express");
const server = express();
const mongoose = require("mongoose");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
require('dotenv').config();

server.use(express.json());

server.use(
  cors({
    credentials: true,
    origin: "*",
  })
);

const DB = async () => {
  try {
    await mongoose.connect(
      process.env.MONGODB_URI,
      {
        serverSelectionTimeoutMS: 30000, // 30 seconds
        socketTimeoutMS: 45000, // 45 seconds
      }
    );
    console.log("databse connected");
  } catch (error) {
    console.log(error);
  }
};
DB();

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    mobile: {
      type: Number,
      required: true,
    },
    course: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

const userModel = mongoose.model("Users", userSchema);

// Function to validate mobile number
const isValidMobileNumber = (mobile) => {
  // Regular expression for a 10-digit mobile number (Indian format)
  const mobileRegex = /^[6-9]\d{9}$/;
  return mobileRegex.test(mobile);
};

server.use(express.static(__dirname));

server.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html")); // Corrected path
});

server.get("/*", (req, res) => {
  res.sendFile(path.join(__dirname, "Error.html")); // Error path
});

server.post("/get-certificate", async (req, res) => {
  const { name, mobile, course } =
    req.body;

  // Validate mobile number
  if (!isValidMobileNumber(mobile)) {
    return res.status(400).send({ success: false, message: "Invalid mobile number" });
  }

  try {
    const user = await userModel.create({
      name,
      mobile,
      course,
    });

    // Set headers for PDF download and prevent caching
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

    const doc = new PDFDocument({
      size: [2000, 1414], // Custom page size matching the image
    });
    doc.pipe(res);

    // Generate the certificate PDF based on the college
    // Use the appropriate college template

    //  doc.image(path.join(__dirname, "PIMT_DM.png"), 0, 0, {
    //   width: 2000,
    //   height: 1414,
    // });
    // doc.fontSize(75).text(name, 0, 720, { align: "center" });

    doc.image(path.join(__dirname, "Certificate.png"), 0, 0, {
      width: 2000,
      height: 1414,
    });
    doc.fontSize(55).text(name, 0, 820, { align: "center" });


    // Finalize the PDF and end the stream
    doc.end();
  } catch (error) {
    console.log(error);
    if (!res.headersSent) {
      res.status(500).send({ success: false, message: error.message });
    } else {
      console.error("Error occurred after headers sent:", error.message);
      res.end();
    }
  }
});

server.listen(process.env.PORT || 8000, () => {
  console.log("server running");
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});
