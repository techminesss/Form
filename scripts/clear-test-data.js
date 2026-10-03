const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
const readline = require("readline");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("Error: MONGODB_URI is not set in environment or .env file.");
    process.exit(1);
  }

  const collectionName =
    process.env.WORKSHOP_COLLECTION || "aiAgentsToolsWorkshopUsers";

  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    console.log("Connected.");

    const collection = mongoose.connection.collection(collectionName);
    const count = await collection.countDocuments();

    console.log(`\nCollection: "${collectionName}"`);
    console.log(`Current document count: ${count}`);

    if (count === 0) {
      console.log("Collection is already empty. Nothing to delete.");
      await mongoose.disconnect();
      process.exit(0);
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      `\nWARNING: Are you sure you want to delete ALL ${count} document(s) from "${collectionName}"?\nType "yes" to confirm: `,
      async (answer) => {
        rl.close();
        if (answer.trim().toLowerCase() === "yes") {
          console.log("\nDeleting documents...");
          const result = await collection.deleteMany({});
          console.log(
            `Successfully deleted ${result.deletedCount} document(s) from "${collectionName}".`
          );
        } else {
          console.log("\nAborted. No documents were deleted.");
        }
        await mongoose.disconnect();
        process.exit(0);
      }
    );
  } catch (error) {
    console.error("Error clearing test data:", error);
    try {
      await mongoose.disconnect();
    } catch (_) {}
    process.exit(1);
  }
}

main();
