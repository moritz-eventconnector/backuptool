import { Router } from "express";
import { getDb } from "../db/index.js";
import { license } from "../db/schema/index.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { verifyLicense, communityLicense } from "../licensing/verifier.js";
import { getMachineFingerprint } from "../licensing/fingerprint.js";
import multer from "multer";

export const licenseRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 } });

// GET /api/license — current license info + this server's fingerprint
licenseRouter.get("/", requireAuth, (_req, res) => {
  const db = getDb();
  const [lic] = db.select().from(license).all();
  const fingerprint = getMachineFingerprint();

  if (!lic) {
    res.json({ ...communityLicense(), source: "default", fingerprint });
    return;
  }
  // Return without rawJwt for security
  res.json({
    edition: lic.edition,
    seats: lic.seats,
    features: JSON.parse(lic.features),
    customerId: lic.customerId,
    customerName: lic.customerName,
    expiresAt: lic.expiresAt,
    activatedAt: lic.activatedAt,
    source: "uploaded",
    fingerprint,
  });
});

// POST /api/license — upload a license file
licenseRouter.post("/", requireAuth, requireRole("admin"), upload.single("license"), async (req, res) => {
  let rawJwt: string;

  if (req.file) {
    rawJwt = req.file.buffer.toString("utf8").trim();
  } else if (req.body.license) {
    rawJwt = (req.body.license as string).trim();
  } else {
    res.status(400).json({ error: "No license file provided. Upload as multipart/form-data field 'license' or JSON body field 'license'." });
    return;
  }

  try {
    const info = await verifyLicense(rawJwt);
    if (!info.valid) {
      res.status(400).json({ error: info.expired ? "License has expired" : "License verification failed" });
      return;
    }

    const db = getDb();
    db.delete(license).run(); // remove existing
    db.insert(license).values({
      id: "singleton",
      rawJwt,
      edition: info.edition,
      seats: info.seats,
      features: JSON.stringify(info.features),
      customerId: info.sub,
      customerName: info.name,
      expiresAt: info.exp ? new Date(info.exp * 1000).toISOString() : null,
    }).run();

    res.json({
      message: "License activated successfully",
      edition: info.edition,
      seats: info.seats,
      expiresAt: info.exp ? new Date(info.exp * 1000).toISOString() : null,
    });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// DELETE /api/license — revert to community
licenseRouter.delete("/", requireAuth, requireRole("admin"), (_req, res) => {
  const db = getDb();
  db.delete(license).run();
  res.json({ message: "License removed. Reverted to Community edition." });
});
