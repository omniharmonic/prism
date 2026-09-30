/**
 * Print a fresh VAPID keypair for Web Push (WP3.3). Copy the lines into
 * apps/server/.env yourself — this script NEVER writes secrets to disk.
 *   npm run gen-vapid -w @prism/server
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log("# Add to apps/server/.env (keep the private key secret; rotating it drops all subscriptions):");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("# VAPID_SUBJECT=mailto:you@example.com   # optional; defaults to mailto:$OWNER_EMAIL");
