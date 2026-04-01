import type { Config } from "drizzle-kit";
import path from "path";

export default {
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DB_PATH ?? path.join(process.cwd(), "data", "db", "backuptool.db"),
  },
} satisfies Config;
