/**
 * PKI utilities for mTLS:
 *  - CA keypair generation (persisted to disk)
 *  - Per-agent client certificate issuance
 *
 * Uses node-forge for RSA + X.509 operations.
 */
import forge from "node-forge";
import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { logger } from "../logger.js";

const CA_SUBJECT = [
  { name: "commonName", value: "BackupTool CA" },
  { name: "organizationName", value: "BackupTool" },
];

let _caCert: forge.pki.Certificate | null = null;
let _caKey: forge.pki.rsa.PrivateKey | null = null;

export async function initCA(): Promise<void> {
  fs.mkdirSync(config.keysDir, { recursive: true });

  if (fs.existsSync(config.caKeyPath) && fs.existsSync(config.caCertPath)) {
    _caKey = forge.pki.privateKeyFromPem(fs.readFileSync(config.caKeyPath, "utf8"));
    _caCert = forge.pki.certificateFromPem(fs.readFileSync(config.caCertPath, "utf8"));
    logger.info("CA keypair loaded from disk");
    return;
  }

  logger.info("Generating new CA keypair (this may take a moment)...");
  const keypair = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 4096, workers: -1 }, (err, kp) => {
      if (err) reject(err);
      else resolve(kp);
    });
  });

  const cert = forge.pki.createCertificate();
  cert.publicKey = keypair.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
  cert.setSubject(CA_SUBJECT);
  cert.setIssuer(CA_SUBJECT);
  cert.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keypair.privateKey, forge.md.sha256.create());

  fs.writeFileSync(config.caKeyPath, forge.pki.privateKeyToPem(keypair.privateKey), { mode: 0o600 });
  fs.writeFileSync(config.caCertPath, forge.pki.certificateToPem(cert));

  _caKey = keypair.privateKey;
  _caCert = cert;
  logger.info("CA keypair generated and saved");
}

export function getCACert(): string {
  if (!_caCert) throw new Error("CA not initialized");
  return forge.pki.certificateToPem(_caCert);
}

/**
 * Issues a client certificate for a given agent.
 * Returns { certPem, keyPem, fingerprint }
 */
export async function issueAgentCert(agentId: string): Promise<{
  certPem: string;
  keyPem: string;
  fingerprint: string;
}> {
  if (!_caKey || !_caCert) throw new Error("CA not initialized");

  const keypair = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) => {
    forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, kp) => {
      if (err) reject(err);
      else resolve(kp);
    });
  });

  const cert = forge.pki.createCertificate();
  cert.publicKey = keypair.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 3);

  // Force UTF8String encoding (tag 12) so Go's strict x509 parser accepts any
  // agentId character without PrintableString validation errors.
  const UTF8 = forge.asn1.Type.UTF8;
  const subject = [
    { name: "commonName", value: `agent:${agentId}`, valueTagClass: UTF8 },
    { name: "organizationName", value: "BackupTool", valueTagClass: UTF8 },
  ] as forge.pki.CertificateField[];
  cert.setSubject(subject);
  cert.setIssuer(_caCert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", clientAuth: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(_caKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keypair.privateKey);

  // SHA-256 fingerprint of the DER-encoded certificate
  const md = forge.md.sha256.create();
  md.update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
  const fingerprint = md.digest().toHex().toUpperCase().match(/.{2}/g)!.join(":");

  return { certPem, keyPem, fingerprint };
}
